import type { interfaces } from "inversify";
import {
    elizaLogger,
    type Plugin,
} from "@elizaos/core";
import type { PluginFactory, PluginOptions } from "../types";

/**
 * Get an instance from the container
 * @param ctx
 * @param item
 * @param type
 * @returns
 */
async function getInstanceFromContainer<T>(
    ctx: interfaces.Context,
    item: T | (new (...args: any[]) => T),
    type: string
): Promise<T | undefined> {
    if (typeof item === "function") {
        try {
            return await ctx.container.getAsync(item);
        } catch (e) {
            elizaLogger.error(
                `Error normalizing ${type}: ${(item as Function).name}`,
                e.message
            );
            return undefined;
        }
    }
    return item;
}

/**
 * Create a plugin factory
 */
export function createPlugin(ctx: interfaces.Context): PluginFactory {
    return async (opts: PluginOptions): Promise<Plugin> => {
        // Create a new plugin object
        const plugin: Plugin = {
            name: opts.name,
            description: opts.description,
        };

        // Handle providers - if provided, map through them
        // For class constructors (functions), get instance from container
        // For regular providers, use as-is
        if (typeof opts.providers !== "undefined") {
            plugin.providers = (
                await Promise.all(
                    opts.providers.map((provider) =>
                        getInstanceFromContainer(
                            ctx,
                            provider,
                            "provider"
                        )
                    )
                )
            ).filter(Boolean); // Filter out undefined providers
        }

        // Handle actions - if provided, map through them
        // For class constructors (functions), get instance from container
        // For regular actions, use as-is
        if (typeof opts.actions !== "undefined") {
            plugin.actions = (
                await Promise.all(
                    opts.actions.map((action) =>
                        getInstanceFromContainer(ctx, action, "action")
                    )
                )
            ).filter(Boolean); // Filter out undefined actions
        }

        // Handle evaluators - if provided, map through them
        // For class constructors (functions), get instance from container
        // For regular evaluators, use as-is
        if (typeof opts.evaluators !== "undefined") {
            plugin.evaluators = (
                await Promise.all(
                    opts.evaluators.map((evaluator) =>
                        getInstanceFromContainer(
                            ctx,
                            evaluator,
                            "evaluator"
                        )
                    )
                )
            ).filter(Boolean); // Filter out undefined evaluators
        }

        // Handle services - if provided, assign directly
        if (typeof opts.services !== "undefined") {
            plugin.services = (
                await Promise.all(
                    opts.services.map((service) =>
                        getInstanceFromContainer(ctx, service, "service")
                    )
                )
            )
        }

        // Handle clients - if provided, assign directly
        if (typeof opts.clients !== "undefined") {
            plugin.clients = (
                await Promise.all(
                    opts.clients.map((client) =>
                        getInstanceFromContainer(ctx, client, "client")
                    )
                )
            )
        }
        return plugin;
    };
}
