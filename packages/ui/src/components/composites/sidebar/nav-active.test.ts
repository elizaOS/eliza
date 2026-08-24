/**
 * Unit tests for nav active markers: validates accent class strings.
 */
import { describe, expect, it } from "vitest";
import {
  navActiveClass,
  navActiveClassHorizontal,
  navActiveClassVertical,
} from "./nav-active.ts";

describe("nav-active", () => {
  it("defines vertical active style with border-l-accent", () => {
    expect(navActiveClassVertical).toContain("border-l-[3px]");
    expect(navActiveClassVertical).toContain("border-l-accent");
    expect(navActiveClassVertical).toContain("bg-accent/12");
  });

  it("defines horizontal active style with border-b-accent", () => {
    expect(navActiveClassHorizontal).toContain("border-b-[3px]");
    expect(navActiveClassHorizontal).toContain("border-b-accent");
    expect(navActiveClassHorizontal).toContain("bg-accent/12");
  });

  it("aliases navActiveClass to vertical active style", () => {
    expect(navActiveClass).toBe(navActiveClassVertical);
  });
});
