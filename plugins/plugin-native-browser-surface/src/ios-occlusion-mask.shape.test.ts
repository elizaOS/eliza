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

describe("iOS Browser outer-clip and occlusion mask contract", () => {
  it("applies the computed outer rounded path independently of overlay holes", () => {
    expect(swiftSource).toContain(
      'let rawOuterClip = call.getObject("outerClip")',
    );
    expect(swiftSource).toContain("layer.mask = outerClipMask");
    expect(swiftSource).toContain(
      "outerClipMask.path = UIBezierPath(rect: bounds).cgPath",
    );
    expect(swiftSource).toContain(
      "outerClipMask.path = (localOuterClipPath() ?? UIBezierPath(rect: bounds)).cgPath",
    );
    expect(swiftSource).toContain(
      "guard localOuterClipPath()?.contains(point) != false else { return false }",
    );
    expect(swiftSource).toContain("private func roundedOuterClipPath(");
  });

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
    expect(swiftSource).toContain(
      "localOuterClipPath() ?? UIBezierPath(rect: bounds)",
    );
  });

  it("updates geometry in place without replacing or navigating the WKWebView", () => {
    expect(swiftSource).toContain(
      "func setSurfaceGeometry(origin: CGPoint, outerClip: HostOuterClip)",
    );
    expect(swiftSource).toContain(
      "surface.container.setSurfaceGeometry( origin: CGPoint(x: x, y: y), outerClip: outerClip )",
    );
    const geometryBody = swiftSource.match(
      /func setSurfaceGeometry\(origin: CGPoint, outerClip: HostOuterClip\) \{(.+?)func setHostOcclusions/,
    )?.[1];
    expect(geometryBody).toBeDefined();
    expect(geometryBody).not.toContain("WKWebView(");
    expect(geometryBody).not.toContain("load(");
    expect(geometryBody).toContain(
      "if surfaceOrigin == origin, hostOuterClip == outerClip { return }",
    );
  });

  it("uses the same rounded union for hit testing", () => {
    expect(swiftSource).toContain(
      "guard localOuterClipPath()?.contains(point) != false else { return false } return !localOcclusionPaths().contains { $0.contains(point) }",
    );
  });
});
