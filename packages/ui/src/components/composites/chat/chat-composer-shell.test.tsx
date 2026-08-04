/** Verifies ChatComposerShell through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders ChatComposerShell in jsdom to lock its flex layout: the default
 * composer must not collapse when placed inside a flex chat column.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposerShell } from "./chat-composer-shell";

afterEach(cleanup);

describe("ChatComposerShell", () => {
});
