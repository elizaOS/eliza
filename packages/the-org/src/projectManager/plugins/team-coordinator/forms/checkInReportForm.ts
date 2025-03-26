import { type Content, logger, type IAgentRuntime } from '@elizaos/core';
import type { HandlerCallback } from '@elizaos/core';

/**
 * Sends a check-in report form to Discord
 * @param callback - The callback function to handle form submission
 * @param channels - Optional array of Discord text channels to display in the form
 * @param serverInfo - Server information containing serverId and serverName
 */
export async function sendCheckInReportForm(
  callback: HandlerCallback,
  channels?: Array<{ id: string; name: string; type: string }>,
  serverInfo?: { serverId: string; serverName?: string }
): Promise<void> {
  logger.info('Sending check-in report form to Discord...');
  logger.info('Server context:', {
    serverId: serverInfo?.serverId,
    serverName: serverInfo?.serverName,
  });
  logger.debug(`Received ${channels?.length || 0} channels for the form`);

  // Log every channel we received for debugging purposes
  if (channels && channels.length > 0) {
    logger.debug('Channels received:');
    for (const channel of channels) {
      logger.debug(`- ${channel.name} (${channel.id}), type: ${channel.type}`);
    }
  }

  // Prepare channel options for dropdown if channels are provided
  const channelOptions =
    channels?.map((channel) => ({
      label: channel.name,
      value: channel.id,
      description: `Text channel: #${channel.name}`,
    })) || [];

  // Log available channels for debugging
  if (channelOptions.length > 0) {
    logger.debug(`Channel options prepared for form: ${channelOptions.length} options`);
  } else {
    logger.warn('No channel options available for the form');
  }

  // IMPORTANT: Discord API limits messages to 5 action rows maximum
  const formComponents = [];
  logger.debug('Building form components...');

  // Add server info as a hidden field instead of select menu
  formComponents.push({
    type: 1, // ACTION_ROW
    components: [
      {
        type: 4, // TEXT_INPUT (hidden)
        custom_id: 'server_info',
        value: JSON.stringify({
          serverId: serverInfo?.serverId,
        }),
        style: 2, // HIDDEN
      },
    ],
  });

  // Add channel selection for sending check-in updates
  if (channelOptions.length > 0) {
    formComponents.push({
      type: 1, // ACTION_ROW
      components: [
        {
          type: 3, // SELECT_MENU
          custom_id: 'report_channel',
          placeholder: 'Select channel to send check-in updates',
          options: channelOptions,
          required: true,
        },
      ],
    });
    logger.debug('Added channel selector for check-in updates');
  }

  // Add submit and cancel buttons
  formComponents.push({
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2, // BUTTON
        style: 1, // PRIMARY
        custom_id: 'submit_report_channel',
        label: 'Confirm Channel',
      },
      {
        type: 2, // BUTTON
        style: 2, // SECONDARY
        custom_id: 'cancel_report_setup',
        label: 'Cancel',
      },
    ],
  });
  logger.debug('Added submit/cancel buttons');

  // Create the final content object
  const content: Content = {
    text: `Server: ${serverInfo?.serverName || 'Unknown'} (ID: ${serverInfo?.serverId})\nSelect a channel where check-in updates should be sent when users submit their responses:`,
    source: 'discord',
    components: formComponents,
  };

  try {
    logger.info('Sending check-in report channel selection form to Discord...');
    logger.debug('Server info being sent:', serverInfo);
    logger.debug('Form components:', JSON.stringify(formComponents, null, 2));
    logger.debug(`Components count: ${formComponents.length}`);

    // Count total action rows to ensure we don't exceed Discord's limit of 5
    if (formComponents.length > 5) {
      logger.error(
        `ERROR: Trying to send ${formComponents.length} components, but Discord only allows 5`
      );
      // Trim components to 5 to avoid API error
      content.components = formComponents.slice(0, 5);
      logger.warn('Components trimmed to 5 to avoid Discord API error');
    }

    await callback(content, []);
    logger.info('Successfully sent check-in report form');
  } catch (error) {
    logger.error(`Error sending check-in report form: ${error}`);
    logger.error('Error stack:', error.stack);
    throw error;
  }
}
