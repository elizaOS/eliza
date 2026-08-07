/**
 * Static contract coverage for the UIKit-only Browser mask boundary. It keeps
 * overlapping holes as a union by requiring one nested alpha mask per hole;
 * runtime paint and touch behavior is then covered on the native device lane.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const currentDir = new URL(".", import.meta.url).pathname;
const swiftSource = readFileSync(
  resolve(
    currentDir,
    "../ios/Sources/BrowserSurfacePlugin/BrowserSurfacePlugin.swift",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("iOS Browser occlusion mask contract", () => {
  it("composes each rounded hole through an independent nested mask", () => {
    expect(swiftSource).toContain("container.installContentView(webView)");
    expect(swiftSource).toContain(
      "maskContainers = paths.map { _ in OcclusionMaskContainerView(frame: bounds) }",
    );
    expect(swiftSource).toContain(
      "for container in maskContainers { parent.addSubview(container) parent = container }",
    );
    expect(swiftSource).toContain(
      "for (container, path) in zip(maskContainers, localOcclusionPaths()) { container.setOcclusionPath(path) }",
    );
    expect(swiftSource).not.toContain(
      "for occlusionPath in localOcclusionPaths() { path.append(occlusionPath) }",
    );
  });

  it("keeps the page attached with zero holes and across hierarchy changes", () => {
    expect(swiftSource).toContain(
      "let expectedContentParent: UIView = maskContainers.last ?? self",
    );
    expect(swiftSource).toContain(
      "if let contentView, contentView.superview !== expectedContentParent { expectedContentParent.addSubview(contentView) }",
    );
    expect(swiftSource).not.toContain(
      "for (container, path) in zip(maskContainers, paths) { container.setOcclusionPath(path) } layoutMaskHierarchy()",
    );
  });

  it("uses the same rounded union for hit testing", () => {
    expect(swiftSource).toContain(
      "return !localOcclusionPaths().contains { $0.contains(point) }",
    );
  });
});
