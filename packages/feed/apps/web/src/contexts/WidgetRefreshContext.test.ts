import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWidgetRefresh,
  WidgetRefreshProvider,
} from "./WidgetRefreshContext";

function HookConsumer({
  onContext,
}: {
  onContext: (context: ReturnType<typeof useWidgetRefresh>) => void;
}) {
  onContext(useWidgetRefresh());
  return null;
}

describe("useWidgetRefresh", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;

  beforeEach(() => {
    env.NODE_ENV = originalNodeEnv;
  });

  afterEach(() => {
    env.NODE_ENV = originalNodeEnv;
  });

  it("exposes registered refresh callbacks when mounted under the provider", () => {
    let refreshCount = 0;

    renderToString(
      createElement(
        WidgetRefreshProvider,
        null,
        createElement(HookConsumer, {
          onContext: ({ registerRefresh, unregisterRefresh, refreshAll }) => {
            registerRefresh("sidebar-widget", () => {
              refreshCount += 1;
            });

            refreshAll();
            unregisterRefresh("sidebar-widget");
            refreshAll();
          },
        }),
      ),
    );

    expect(refreshCount).toBe(1);
  });

  it("throws outside the provider in non-production environments", () => {
    env.NODE_ENV = "test";

    expect(() =>
      renderToString(createElement(HookConsumer, { onContext: () => {} })),
    ).toThrow("useWidgetRefresh must be used within WidgetRefreshProvider");
  });

  it("returns a no-op context outside the provider in production", () => {
    env.NODE_ENV = "production";

    expect(() =>
      renderToString(
        createElement(HookConsumer, {
          onContext: ({ registerRefresh, unregisterRefresh, refreshAll }) => {
            registerRefresh("sidebar-widget", () => {
              throw new Error("no-op context should not run refresh callbacks");
            });
            refreshAll();
            unregisterRefresh("sidebar-widget");
          },
        }),
      ),
    ).not.toThrow();
  });
});
