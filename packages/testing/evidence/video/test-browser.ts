/** Gates browser integration tests only on a missing download; installed-browser failures must fail the tests. */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

export const hasChromium = existsSync(chromium.executablePath());
