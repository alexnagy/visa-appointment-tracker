import * as dateFns from 'date-fns';
import * as Eta from 'eta';
import WorkflowCommand from '@/workflow-command';
import { GetAvailableAppointmentConsulatesExecutionState } from '@/workflows/execution-states';
import { AppointmentConsulate, AppointmentDate } from '@/types';

export default class NotifyAvailableDatesWorkflowCommand extends WorkflowCommand<GetAvailableAppointmentConsulatesExecutionState> {
  static getId(): string {
    return 'notify-available-dates';
  }

  public shouldRetry(): boolean {
    return true;
  }

  async retryableExecute(): Promise<void> {
    const appointmentConsulates = this.executionState.getAppointmentConsulatesOrThrow();
    const minPreferredDate = this.buildMinPreferredDate();
    const maxPreferredDate = this.buildMaxPreferredDate();

    const consulatesWithAvailableDateWithinPreferredPeriod = appointmentConsulates.map((consulate) => {
      return {
        ...consulate,
        availableDates: consulate.availableDates.filter((availableDate) => {
          const isPreferredDate = dateFns.isWithinInterval(availableDate, {
            start: minPreferredDate,
            end: maxPreferredDate,
          });

          this.logger.info(`Checking if available date for ${consulate.cityName} is within the preferred period...`, {
            availableDate,
            minPreferredDate,
            maxPreferredDate,
            isPreferredDate,
          });

          return isPreferredDate;
        }),
      };
    });

    const consulatesWithSomePreferredAvailableDate = consulatesWithAvailableDateWithinPreferredPeriod.filter(
      ({ availableDates }) => {
        return availableDates.length > 0;
      }
    );

    const totalOfAvailableDates = this.buildTotalOfAvailableDatesFromAppointmentConsulates(
      consulatesWithSomePreferredAvailableDate
    );

    const loggerWithPreferredAvailableDates = this.logger.child({
      consulatesWithAvailableDateWithinPreferredPeriod,
    });

    if (totalOfAvailableDates > 0) {
      loggerWithPreferredAvailableDates.info(`Notifying ${totalOfAvailableDates} available dates...`);
      await this.notifyAppointmentConsulatesWithAvailableDatesWithinPreferredPeriod(
        consulatesWithSomePreferredAvailableDate
      );
      return;
    }

    loggerWithPreferredAvailableDates.info('Skipping notification...');
  }

  private buildMinPreferredDate(): Date {
    const { visaMinAppointmentDate } = this.config.workflows.getAvailableAppointmentConsulates;
    return dateFns.startOfDay(dateFns.parse(visaMinAppointmentDate, 'yyyy-MM-dd', new Date()));
  }

  private buildMaxPreferredDate(): Date {
    const { visaMaxAppointmentDate } = this.config.workflows.getAvailableAppointmentConsulates;
    return dateFns.endOfDay(dateFns.parse(visaMaxAppointmentDate, 'yyyy-MM-dd', new Date()));
  }

  private buildTotalOfAvailableDatesFromAppointmentConsulates(appointmentConsulates: AppointmentConsulate[]): number {
    const totalOfAvailableDates = appointmentConsulates.reduce((partialTotalOfAvailableDates, { availableDates }) => {
      return partialTotalOfAvailableDates + availableDates.length;
    }, 0);

    return totalOfAvailableDates;
  }

  private async notifyAppointmentConsulatesWithAvailableDatesWithinPreferredPeriod(
    appointmentConsulates: AppointmentConsulate[]
  ): Promise<void> {
    const {
      twilioAccountSid,
      twilioAuthToken,
      visaNotificationMessage,
      visaNotificationMessageLang,
      twilioCallerNumber,
      twilioReceiverNumber,
    } = this.config.workflows.getAvailableAppointmentConsulates;

    const availableCities = appointmentConsulates.map(({ cityName }) => cityName);
    const { cityName: earliestAvailableCityName, date: earliestAvailableDate } =
      this.buildEarliestAppointmentDateFromAppointmentConsulates(appointmentConsulates);
    const { cityName: latestAvailableCityName, date: latestAvailableDate } =
      this.buildLatestAppointmentDateFromAppointmentConsulates(appointmentConsulates);

    const totalOfAvailableDates = this.buildTotalOfAvailableDatesFromAppointmentConsulates(appointmentConsulates);
    const messageTemplateVariables = {
      availableCities,
      totalOfAvailableDates,
      earliestAvailableCityName,
      earliestAvailableDate: this.formatDateToLocale(earliestAvailableDate),
      latestAvailableCityName,
      latestAvailableDate: this.formatDateToLocale(latestAvailableDate),
    };

    const message = <string>Eta.render(visaNotificationMessage, messageTemplateVariables);

    this.logger.info(`Notifying the following message: "${message}"`, { messageTemplateVariables });

    const response = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        'phone': twilioReceiverNumber,
        'message': message,
        'key': twilioAuthToken,
        }),
    });

    if (!response.ok) {
      this.logger.error(`HTTP error! status: ${response.status} message: ${response.statusText}`);
    }
  }

  private buildEarliestAppointmentDateFromAppointmentConsulates(
    appointmentConsulates: AppointmentConsulate[]
  ): AppointmentDate {
    const appointmentDates = this.buildAppointmentDatesFromAppointmentConsulates(appointmentConsulates);
    const [earliestAppointment] = appointmentDates.sort((leftAppointmentDate, rightAppointmentDate) => {
      const areLeftAndRightDatesEqual = dateFns.isEqual(leftAppointmentDate.date, rightAppointmentDate.date);

      if (areLeftAndRightDatesEqual) {
        return 0;
      }

      const earliestDate = dateFns.min([leftAppointmentDate.date, rightAppointmentDate.date]);
      const isLeftDateSoonerThanRight = dateFns.isEqual(earliestDate, leftAppointmentDate.date);

      if (isLeftDateSoonerThanRight) {
        return -1;
      }

      return 1;
    });

    return earliestAppointment;
  }

  private buildAppointmentDatesFromAppointmentConsulates(
    appointmentConsulates: AppointmentConsulate[]
  ): AppointmentDate[] {
    const initialAppointmentDates: AppointmentDate[] = [];

    return appointmentConsulates.reduce((partialAppointmentDates, consulate) => {
      const { cityId, cityName, availableDates } = consulate;
      const consulateAppointmentDates = availableDates.map((date) => {
        return { cityId, cityName, date };
      });

      return [...partialAppointmentDates, ...consulateAppointmentDates];
    }, initialAppointmentDates);
  }

  private buildLatestAppointmentDateFromAppointmentConsulates(
    appointmentConsulates: AppointmentConsulate[]
  ): AppointmentDate {
    const appointmentDates = this.buildAppointmentDatesFromAppointmentConsulates(appointmentConsulates);
    const [latestAppointment] = appointmentDates.sort((leftAppointmentDate, rightAppointmentDate) => {
      const areLeftAndRightDatesEqual = dateFns.isEqual(leftAppointmentDate.date, rightAppointmentDate.date);

      if (areLeftAndRightDatesEqual) {
        return 0;
      }

      const latestDate = dateFns.max([leftAppointmentDate.date, rightAppointmentDate.date]);
      const isLeftDateLaterThanRight = dateFns.isEqual(latestDate, leftAppointmentDate.date);

      if (isLeftDateLaterThanRight) {
        return -1;
      }

      return 1;
    });

    return latestAppointment;
  }

  private formatDateToLocale(date: Date): string {
    const { visaNotificationMessageLang } = this.config.workflows.getAvailableAppointmentConsulates;
    const locale = require(`date-fns/locale/${visaNotificationMessageLang}`);
    return dateFns.format(date, 'PPP', { locale });
  }
}
