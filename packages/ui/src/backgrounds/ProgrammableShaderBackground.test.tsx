// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgrammableShaderBackground } from "./ProgrammableShaderBackground";
import { getShaderPreset } from "./shader-presets";
import { DEFAULT_SHADER_UNIFORMS } from "./shader-schema";

afterEach(cleanup);

const SOURCE = getShaderPreset("aurora")?.source ?? "";

describe("ProgrammableShaderBackground", () => {
  it("always renders the host layer so the shell background slot is filled", () => {
    render(
      <ProgrammableShaderBackground
        source={SOURCE}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ef5a1f"
      />,
    );
    const host = screen.getByTestId("app-background-glsl");
    expect(host).toBeTruthy();
    expect(host.getAttribute("data-eliza-bg")).toBe("glsl");
    // The base color is painted underneath so there's never a blank frame while
    // the GL context (or the fallback) resolves.
    expect(host.style.backgroundColor).toBeTruthy();
  });

  it("falls back (no white-screen / hang) when WebGL is unavailable — jsdom has no GL context", () => {
    const onFallback = vi.fn();
    render(
      <ProgrammableShaderBackground
        source={SOURCE}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ef5a1f"
        onFallback={onFallback}
      />,
    );
    // jsdom cannot create a WebGL context, so the safety path must trigger a
    // fallback rather than throw or leave a dead canvas.
    expect(onFallback).toHaveBeenCalled();
    expect(typeof onFallback.mock.calls[0][0]).toBe("string");
  });

  it("does not throw for a hostile/garbage source (safety path swallows it)", () => {
    const onFallback = vi.fn();
    expect(() =>
      render(
        <ProgrammableShaderBackground
          source={"@@@ not glsl at all @@@"}
          uniforms={DEFAULT_SHADER_UNIFORMS}
          color="#000000"
          onFallback={onFallback}
        />,
      ),
    ).not.toThrow();
    expect(onFallback).toHaveBeenCalled();
  });
});
