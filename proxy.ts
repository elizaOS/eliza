import { onlyAlphaNumeric, waitMs } from "@server/helpers/utils";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";

export type ProxyOptions = {
    name: string;
    autoRefresh?: boolean;
    refreshTimerMs?: number;
};

const sevenHours = 1000 * 60 * 60 * 7;

export abstract class Proxy extends Loggable {
    tag = "Proxy";

    opts: ProxyOptions;

    url: string;

    refreshTimer: NodeJS.Timeout = null;

    /**
     * Determines if we "should" restart the service.
     * This means that we haven't had a recent connection.
     * We do this so we do not accidentally interrupt a download process
     * or API request.
     */
    static get shouldRestart(): boolean {
        const now = new Date().getTime();
        const lastConn = Server().lastConnection;
        if (!lastConn) return true;

        const threshold = 1000 * 60 * 2; // 2 minutes
        return now - lastConn > threshold;
    }

    constructor(opts: ProxyOptions) {
        super();

        this.opts = opts;
        this.url = null;
        this.refreshTimer = null;

        this.opts.refreshTimerMs = this.opts.refreshTimerMs ?? sevenHours;
        this.opts.autoRefresh = this.opts.autoRefresh ?? false;
    }

    /**
     * Helper for checking if we are connected
     */
    isConnected(): boolean {
        return this.url !== null;
    }

    /**
     * Checks to see if the service can be started
     */
    canStart(): boolean {
        const enabledProxy = Server().repo.getConfig("proxy_service") as string;
        return onlyAlphaNumeric(enabledProxy).toLowerCase() === onlyAlphaNumeric(this.opts.name).toLowerCase();
    }

    async applyAddress(address?: string) {
        if (address || this.url) {
            await Server().repo.setConfig("server_address", address ?? this.url);
        }
    }

    /**
     * Sets up a connection to the Ngrok servers, opening a secure
     * tunnel between the internet and your Mac (iMessage server)
     */
    async start(): Promise<void> {
        if (!this.canStart()) {
            this.log.info(`${this.opts.name} proxy is disabled. Not restarting.`);
            return;
        }

        // Clear the refresh timer
        if ((this.opts.autoRefresh ?? false) && this.refreshTimer) clearTimeout(this.refreshTimer);

        // Connect to the service
        try {
            this.url = await this.connect();
            this.applyAddress(this.url);
        } catch (ex: any) {
            this.log.info(`Failed to connect to ${this.opts.name}! Error: ${ex.toString()}`);
            throw ex;
        }

        // Start the new refresh timer (if available)
        if (this.opts.autoRefresh ?? false) {
            this.log.debug(`Starting ${this.opts.name} refresh timer. Waiting ${this.opts.refreshTimerMs} ms`);
            this.refreshTimer = setTimeout(async () => {
                const success = await Proxy.waitForIdle();
                if (!success) {
                    this.log.debug(`Restarting ${this.opts.name} process due to session & idle timeout...`);
                } else {
                    this.log.debug(`Restarting ${this.opts.name} process due to session timeout...`);
                }

                await this.restart();
            }, this.opts.refreshTimerMs);
        }
    }

    static async waitForIdle(): Promise<boolean> {
        let canRestart = false;
        let tryCount = 0;
        while (!canRestart) {
            tryCount += 1;
            canRestart = Proxy.shouldRestart;

            if (!canRestart) {
                // If we can't restart and we've tried 20 times (10 minutes),
                // return out and force a restart
                if (tryCount >= 20) return false;

                // Wait 30 seconds to check again
                await waitMs(1000 * 30);
            }
        }

        return true;
    }

    /**
     * Connect to the proxy, return the URL
     */
    abstract connect(): Promise<string>;

    /**
     * Disconnect from proxy
     */
    abstract disconnect(): Promise<void>;

    async checkForError(log: string, err: any = null): Promise<boolean> {
        return false;
    }

    async shouldRelaunch(): Promise<boolean> {
        return true;
    }

    /**
     * Helper for restarting the ngrok connection
     */
    async restart(): Promise<boolean> {
        try {
            await this.disconnect();
        } catch (ex: any) {
            // Don't do anything
        }

        if (!this.canStart()) {
            this.log.info(`${this.opts.name} proxy is diabled. Not restarting.`);
            return false;
        }

        const maxTries = 10;
        let tries = 0;
        let connected = false;

        // Retry when we aren't connected and we haven't hit our try limit
        while (tries < maxTries && !connected) {
            tries += 1;

            // Set the wait time based on which try we are attempting
            const wait = tries > 1 ? 2000 * tries : 1000;
            this.log.info(`Attempting to restart ${this.opts.name} (attempt ${tries}; ${wait} ms delay)`);
            connected = await this.restartHandler(wait);
        }

        // Log some nice things (hopefully)
        if (connected) {
            this.log.info(
                `Successfully connected to ${this.opts.name} after ${tries} ${tries === 1 ? "try" : "tries"}`
            );
        } else {
            this.log.info(`Failed to connect to ${this.opts.name} after ${maxTries} tries`);
        }

        if (tries >= maxTries) {
            if (await this.shouldRelaunch()) {
                this.log.info(`Reached maximum retry attempts for ${this.opts.name}. Force restarting app...`);
                Server().relaunch();
            } else {
                this.log.warn('Max retry attempts reached for proxy service! Not relaunching...');
            }
        }

        return connected;
    }

    /**
     * Restarts ngrok (retries 3 times)
     */
    async restartHandler(wait = 1000): Promise<boolean> {
        try {
            await this.disconnect();
            await waitMs(wait);
            await this.start();
        } catch (ex: any) {
            const output = ex?.toString() ?? "";
            const wasHandled = await this.checkForError(output, ex);
            if (!wasHandled) {
                this.log.error(`Failed to restart ${this.opts.name}! Error: ${ex}`);
            }

            return false;
        }

        return true;
    }
}
