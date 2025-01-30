import { composeContext, elizaLogger } from "@elizaos/core";
import { generateMessageResponse } from "@elizaos/core";
import {
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
} from "@elizaos/core";
import { validateOpenWeatherConfig } from "../environment";
import { getCurrentWeatherTemplate } from "../templates";
import { getCurrentWeatherExamples } from "../examples";
import { createWeatherService } from "../services";

export const getCurrentWeatherAction: Action = {
    name: "GET_CURRENT_WEATHER",
    similes: [
        "WEATHER",
        "TEMPERATURE",
        "FORECAST",
        "WEATHER_REPORT",
        "WEATHER_UPDATE",
        "CHECK_WEATHER",
        "WEATHER_CHECK",
        "CHECK_TEMPERATURE",
        "WEATHER_OUTSIDE",
    ],
    description: "Get the current weather for a given location",
    validate: async (runtime: IAgentRuntime) => {
        await validateOpenWeatherConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        // Initialize/update state
        let currentState: State = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        }
        currentState = await runtime.updateRecentMessageState(currentState);

        // state -> context
        const weatherContext = composeContext({
            state: currentState,
            template: getCurrentWeatherTemplate,
        });

        // context -> content
        const content = await generateMessageResponse({
            runtime,
            context: weatherContext,
            modelClass: ModelClass.SMALL,
        });

        // parse content
        const hasLocation =
            content?.city && content?.country && !content?.error;

        if (!hasLocation) {
            return;
        }

        // Instantiate API service
        const config = await validateOpenWeatherConfig(runtime);
        const weatherService = createWeatherService(
            config.OPEN_WEATHER_API_KEY
        );

        // Fetch weather & respond
        try {
            const weatherData = await weatherService.getWeather(
                String(content?.city || ""),
                content?.country ? String(content?.country) : undefined
            );
            elizaLogger.success(
                `Successfully fetched weather for ${content.city}, ${content.country}`
            );

            if (callback) {
                callback({
                    text: `The current weather in ${content.city}, ${content.country} is ${weatherData.main.temp}°C, feels like ${weatherData.main.feels_like}°C, and is ${weatherData.weather[0].description} with a wind speed of ${weatherData.wind.speed} km/h.`,
                    content: weatherData,
                });

                return true;
            }
        } catch (error) {
            elizaLogger.error("Error in GET_CURRENT_WEATHER handler:", error);

            callback({
                text: `Error fetching weather: ${error.message}`,
                content: { error: error.message },
            });

            return false;
        }

        return;
    },
    examples: getCurrentWeatherExamples as ActionExample[][],
} as Action;
