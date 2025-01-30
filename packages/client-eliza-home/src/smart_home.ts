import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { SmartThingsApi } from "./services/smart_things_api";
import { CommandParser } from "./utils/command_parser";
import { homeShouldRespondTemplate, homeMessageHandlerTemplate } from "./templates";

export class SmartHomeManager {
    private runtime: IAgentRuntime;
    private api: SmartThingsApi;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.api = new SmartThingsApi(runtime);
    }

    async handleCommand(command: string, userId: string): Promise<any> {
        try {
            // First check if we should respond using the template
            const shouldRespond = await this.runtime.llm.shouldRespond(
                homeShouldRespondTemplate,
                command
            );

            if (shouldRespond !== 'RESPOND') {
                return null;
            }

            // Parse the command using CommandParser
            const parsedCommand = CommandParser.parseCommand(command);
            const deviceCommand = CommandParser.mapToDeviceCommand(
                parsedCommand.command,
                parsedCommand.args
            );

            // Execute the command
            const result = await this.executeCommand(deviceCommand);

            // Generate response using template
            const response = await this.runtime.llm.complete(
                homeMessageHandlerTemplate,
                {
                    command,
                    result,
                    homeState: await this.getCurrentState()
                }
            );

            return {
                success: true,
                message: response,
                data: result
            };

        } catch (error) {
            elizaLogger.error("Error handling smart home command:", error);
            throw error;
        }
    }

    private async getCurrentState(): Promise<string> {
        try {
            const devices = await this.api.devices.list();
            return devices
                .map(device => `${device.name}: ${JSON.stringify(device.status)}`)
                .join('\n');
        } catch (error) {
            elizaLogger.error("Error getting current state:", error);
            return "Unable to fetch current state";
        }
    }

    private async executeCommand(deviceCommand: any): Promise<any> {
        try {
            return await this.api.devices.executeCommand(
                deviceCommand.deviceId,
                {
                    capability: deviceCommand.capability,
                    command: deviceCommand.command,
                    arguments: deviceCommand.arguments
                }
            );
        } catch (error) {
            elizaLogger.error("Error executing smart home command:", error);
            throw error;
        }
    }
}