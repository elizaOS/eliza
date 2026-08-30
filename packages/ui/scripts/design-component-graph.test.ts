/**
 * Exercises exhaustive React symbol discovery across barrels, local wrappers,
 * dependency cycles, and independent consumer domains using temporary sources.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverComponentGraph } from "./design-component-graph.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureProject(files: Readonly<Record<string, string>>): {
  root: string;
  absoluteFiles: string[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-components-"));
  temporaryRoots.push(root);
  const absoluteFiles = Object.entries(files).map(([relativeFile, source]) => {
    const absoluteFile = path.join(root, "packages/ui/src", relativeFile);
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, source);
    return absoluteFile;
  });
  return { root, absoluteFiles };
}

describe("discoverComponentGraph", () => {
  it("discovers every JSX component in a multi-declarator statement", () => {
    const fixture = fixtureProject({
      "components/shared/Pair.tsx": [
        "export const First = () => <section className='bg-card' />,",
        "  Second = () => <button type='button' />;",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });
    assert.deepEqual(
      graph.components.map((component) => component.symbol).sort(),
      ["First", "Second"],
    );
    assert.equal(
      graph.components.find((component) => component.symbol === "First")
        ?.rawCapabilities[0]?.capabilities[0],
      "paint.surface",
    );
    assert.equal(
      graph.components.find((component) => component.symbol === "Second")
        ?.rawCapabilities[0]?.capabilities[0],
      "interaction.activate",
    );
  });

  it("attributes property-held components and their property-access consumers", () => {
    const fixture = fixtureProject({
      "components/shared/Widgets.tsx": [
        "export const Widgets = {",
        "  Molecule: () => <section className='rounded-lg bg-card' /> ,",
        "  Method() { return <button type='button' />; },",
        "  Factory: function () { return <aside className='border' />; },",
        "  NotAComponent: () => 'plain text',",
        "};",
      ].join("\n"),
      "components/settings/Consumer.tsx": [
        "import React from 'react';",
        "import { Widgets } from '../shared/Widgets';",
        "export function SettingsConsumer() {",
        "  return <><Widgets.Molecule /><Widgets.Method />{React.createElement(Widgets.Factory)}</>;",
        "}",
      ].join("\n"),
      "components/connectors/Consumer.tsx": [
        "import React from 'react';",
        "import { Widgets } from '../shared/Widgets';",
        "export function ConnectorConsumer() {",
        "  return React.createElement(React.Fragment, null, React.createElement(Widgets.Molecule), <Widgets.Method />, <Widgets.Factory />);",
        "}",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });

    assert.equal(
      graph.components.some((component) => component.symbol === "Widgets"),
      false,
      "the object namespace is not itself a React component",
    );
    assert.equal(
      graph.components.some(
        (component) => component.symbol === "Widgets.NotAComponent",
      ),
      false,
      "a property without React rendering is not inferred as a component",
    );
    const expectedCapabilities = new Map([
      ["Widgets.Molecule", ["paint.radius", "paint.surface"]],
      ["Widgets.Method", ["interaction.activate"]],
      ["Widgets.Factory", ["paint.border"]],
    ]);
    for (const [symbol, capabilities] of expectedCapabilities) {
      const component = graph.components.find(
        (candidate) => candidate.symbol === symbol,
      );
      assert.ok(component, `${symbol} must have its own component owner`);
      assert.equal(component.exported, true, symbol);
      assert.equal(component.inferredLayer, "molecule", symbol);
      assert.equal(component.discoveryReason, "cross-domain-reuse", symbol);
      assert.deepEqual(component.consumerDomains, [
        "components/connectors",
        "components/settings",
      ]);
      assert.equal(component.consumers.length, 2, symbol);
      assert.deepEqual(
        component.rawCapabilities[0]?.capabilities,
        capabilities,
      );
    }
  });

  it("does not treat explicitly disabled draggable media as activation", () => {
    const fixture = fixtureProject({
      "components/shared/Artwork.tsx":
        "export function Artwork() { return <img draggable={false} onError={() => undefined} />; }",
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities, []);
  });

  it("resolves atoms through barrels and local wrappers transitively", () => {
    const fixture = fixtureProject({
      "components/ui/button.tsx":
        "export function Button() { return <button type='button' />; }",
      "components/ui/index.ts": "export { Button as Action } from './button';",
      "components/composites/Outer.tsx": [
        "import { Action } from '../ui';",
        "function Inner() { return <Action />; }",
        "export function Outer() { return <Inner />; }",
      ].join("\n"),
    });
    const buttonFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/button.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${buttonFile}#Button`, "button"]]),
      sourceRoot: fixture.root,
    });
    const outer = graph.components.find(
      (component) => component.symbol === "Outer",
    );
    assert.deepEqual(outer?.directAtoms, []);
    assert.deepEqual(outer?.transitiveAtoms, ["button"]);
    assert.equal(outer?.inferredLayer, "molecule");
    assert.equal(
      outer?.id,
      "packages/ui/src/components/composites/Outer.tsx#Outer",
    );
  });

  it("infers cross-domain reuse without a registry entry", () => {
    const fixture = fixtureProject({
      "components/shared/CapabilityChoice.tsx":
        "export function CapabilityChoice() { return <section />; }",
      "components/settings/Consumer.tsx": [
        "import { CapabilityChoice } from '../shared/CapabilityChoice';",
        "export function SettingsConsumer() { return <CapabilityChoice />; }",
      ].join("\n"),
      "components/connectors/Consumer.tsx": [
        "import { CapabilityChoice } from '../shared/CapabilityChoice';",
        "export function ConnectorConsumer() { return <CapabilityChoice />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    const shared = graph.components.find(
      (component) => component.symbol === "CapabilityChoice",
    );
    assert.deepEqual(shared?.consumerDomains, [
      "components/connectors",
      "components/settings",
    ]);
    assert.equal(shared?.discoveryReason, "cross-domain-reuse");
    assert.equal(shared?.inferredLayer, "molecule");
  });

  it("infers reuse from multiple consumers in one domain", () => {
    const fixture = fixtureProject({
      "components/settings/SharedChoice.tsx":
        "export function SharedChoice() { return <section />; }",
      "components/settings/First.tsx": [
        "import { SharedChoice } from './SharedChoice';",
        "export function First() { return <SharedChoice />; }",
      ].join("\n"),
      "components/settings/Second.tsx": [
        "import { SharedChoice } from './SharedChoice';",
        "export function Second() { return <SharedChoice />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    const shared = graph.components.find(
      (component) => component.symbol === "SharedChoice",
    );
    assert.equal(shared?.discoveryReason, "multi-consumer-reuse");
    assert.equal(shared?.inferredLayer, "molecule");
    assert.equal(shared?.consumers.length, 2);
  });

  it("does not exempt reusable page, shell, or layout components by directory", () => {
    for (const ownerFile of [
      "components/pages/Shared.tsx",
      "components/shell/Shared.tsx",
      "layouts/shared/Shared.tsx",
    ]) {
      const fixture = fixtureProject({
        [ownerFile]:
          "export function Shared() { return <section className='bg-card' />; }",
        "components/settings/First.tsx": [
          `import { Shared } from '../../${ownerFile.replace(/\.tsx$/, "")}';`,
          "export function First() { return <Shared />; }",
        ].join("\n"),
        "components/settings/Second.tsx": [
          `import { Shared } from '../../${ownerFile.replace(/\.tsx$/, "")}';`,
          "export function Second() { return <Shared />; }",
        ].join("\n"),
      });
      const graph = discoverComponentGraph({
        absoluteFiles: fixture.absoluteFiles,
        atomOwnerByKey: new Map(),
      });
      const shared = graph.components.find((component) =>
        component.file.endsWith(ownerFile),
      );
      assert.equal(shared?.inferredLayer, "molecule", ownerFile);
      assert.equal(shared?.rawCapabilities.length, 1, ownerFile);
    }
  });

  it("distinguishes consumers in separate plugin workspaces", () => {
    const fixture = fixtureProject({
      "../../../plugins/plugin-a/src/Consumer.tsx": [
        "import { Shared } from '../../../packages/ui/src/components/shared/Shared';",
        "export function PluginAConsumer() { return <Shared />; }",
      ].join("\n"),
      "../../../plugins/plugin-b/src/Consumer.tsx": [
        "import { Shared } from '../../../packages/ui/src/components/shared/Shared';",
        "export function PluginBConsumer() { return <Shared />; }",
      ].join("\n"),
      "components/shared/Shared.tsx":
        "export function Shared() { return <section />; }",
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    const shared = graph.components.find(
      (component) => component.symbol === "Shared",
    );
    assert.deepEqual(shared?.consumerDomains, [
      "plugins/plugin-a",
      "plugins/plugin-b",
    ]);
    assert.equal(shared?.inferredLayer, "molecule");
  });

  it("terminates cycles and carries atom closure to every wrapper", () => {
    const fixture = fixtureProject({
      "components/ui/badge.tsx": "export function Badge() { return <span />; }",
      "components/composites/Cycle.tsx": [
        "import { Badge } from '../ui/badge';",
        "export function A() { return <B />; }",
        "export function B() { return <><A /><Badge /></>; }",
      ].join("\n"),
    });
    const badgeFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/badge.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${badgeFile}#Badge`, "badge"]]),
    });
    for (const symbol of ["A", "B"]) {
      assert.deepEqual(
        graph.components.find((component) => component.symbol === symbol)
          ?.transitiveAtoms,
        ["badge"],
      );
    }
  });

  it("classifies raw painted and interactive capabilities inside molecules", () => {
    const fixture = fixtureProject({
      "components/composites/RawCard.tsx": [
        "const cn = (...values: unknown[]) => values.join(' ');",
        "export function RawCard() {",
        "  return <div onClick={() => undefined} className={cn('rounded-lg border', true && 'bg-card shadow-sm')} />;",
        "}",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities[0]?.capabilities, [
      "interaction.activate",
      "paint.border",
      "paint.elevation",
      "paint.radius",
      "paint.surface",
    ]);
  });

  it("does not govern isolated browser fixtures as shipped molecules", () => {
    const fixture = fixtureProject({
      "components/composites/__e2e__/fixture.tsx":
        "export function DragFixture() { return <div onPointerDown={() => undefined} />; }",
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.equal(graph.components[0]?.inferredLayer, "organism");
    assert.equal(
      graph.components[0]?.discoveryReason,
      "domain-private-composition",
    );
  });

  it("resolves class recipes referenced through local identifiers", () => {
    const fixture = fixtureProject({
      "components/composites/IdentifierCard.tsx": [
        "const surfaceClassName = 'rounded-lg border bg-card';",
        "export function IdentifierCard() { return <div className={surfaceClassName} />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities[0]?.capabilities, [
      "paint.border",
      "paint.radius",
      "paint.surface",
    ]);
  });

  it("attributes visual overrides on canonical atoms to the molecule", () => {
    const fixture = fixtureProject({
      "components/ui/card.tsx":
        "export function Card() { return <div className='rounded-sm bg-card' />; }",
      "components/composites/Override.tsx": [
        "import { Card } from '../ui/card';",
        "export function Override() { return <Card className='rounded-lg border' />; }",
      ].join("\n"),
    });
    const cardFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/card.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${cardFile}#Card`, "card"]]),
    });
    const molecule = graph.components.find(
      (component) => component.symbol === "Override",
    );
    assert.equal(molecule?.rawCapabilities[0]?.host, "Card");
    assert.deepEqual(molecule?.rawCapabilities[0]?.capabilities, [
      "paint.border",
      "paint.radius",
    ]);
  });

  it("detects object-key recipes, inline paint, and semantic activation", () => {
    const fixture = fixtureProject({
      "components/composites/Indirect.tsx": [
        "const cn = (...values: unknown[]) => values.join(' ');",
        "export function Indirect() {",
        "  return <section className={cn({ 'bg-card rounded-lg': true })} style={{ borderColor: 'red', boxShadow: 'none' }}><a href='/next'>Next</a></section>;",
        "}",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities, [
      {
        capabilities: [
          "paint.border",
          "paint.elevation",
          "paint.radius",
          "paint.surface",
        ],
        file: fixture.absoluteFiles[0],
        host: "section",
        line: 3,
      },
      {
        capabilities: ["interaction.activate"],
        file: fixture.absoluteFiles[0],
        host: "a",
        line: 3,
      },
    ]);
  });

  it("does not exempt an atom wrapper when asChild is false", () => {
    const fixture = fixtureProject({
      "components/ui/button.tsx":
        "export function Button() { return <button type='button' />; }",
      "components/composites/FalseSlot.tsx": [
        "import { Button } from '../ui/button';",
        "export function FalseSlot() { return <Button asChild={false}><a href='/next'>Next</a></Button>; }",
      ].join("\n"),
    });
    const buttonFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/button.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${buttonFile}#Button`, "button"]]),
    });
    const molecule = graph.components.find(
      (component) => component.symbol === "FalseSlot",
    );
    assert.deepEqual(molecule?.rawCapabilities[0]?.capabilities, [
      "interaction.activate",
    ]);
  });

  it("resolves capabilities hidden in JSX spreads and helper expressions", () => {
    const fixture = fixtureProject({
      "components/composites/SpreadCard.tsx": [
        "const recipe = () => 'rounded-lg border bg-card shadow-sm';",
        "const visualStyle = { borderRadius: 8 };",
        "const props = { className: recipe(), style: visualStyle, onClick: () => undefined };",
        "export function SpreadCard() { return <div {...props} />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities[0]?.capabilities, [
      "interaction.activate",
      "paint.border",
      "paint.elevation",
      "paint.radius",
      "paint.surface",
    ]);
  });

  it("classifies intrinsic aliases as raw hosts", () => {
    const fixture = fixtureProject({
      "components/composites/AliasButton.tsx": [
        "const Host = 'button';",
        "export function AliasButton() { return <Host />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities[0]?.capabilities, [
      "interaction.activate",
    ]);
  });

  it("only exempts a direct slot when asChild is provably true", () => {
    const fixture = fixtureProject({
      "components/ui/button.tsx":
        "export function Button() { return <button type='button' />; }",
      "components/composites/Slots.tsx": [
        "import { Button } from '../ui/button';",
        "declare const uncertain: boolean;",
        "export function CertainSlot() { return <Button asChild><a href='/ok'>OK</a></Button>; }",
        "export function UncertainSlot() { return <Button asChild={uncertain}><a href='/next'>Next</a></Button>; }",
      ].join("\n"),
    });
    const buttonFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/button.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${buttonFile}#Button`, "button"]]),
    });
    assert.deepEqual(
      graph.components.find((component) => component.symbol === "CertainSlot")
        ?.rawCapabilities,
      [],
    );
    assert.deepEqual(
      graph.components.find((component) => component.symbol === "UncertainSlot")
        ?.rawCapabilities[0]?.capabilities,
      ["interaction.activate"],
    );
  });

  it("discovers uppercase export aliases and createElement-only components", () => {
    const fixture = fixtureProject({
      "components/composites/Exports.tsx": [
        "import React from 'react';",
        "function lowercase() { return React.createElement('section'); }",
        "export { lowercase as LowercaseCard };",
        "export function FactoryCard() { return React.createElement('div'); }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(
      graph.components.map((component) => component.symbol).sort(),
      ["FactoryCard", "lowercase"],
    );
    assert.equal(
      graph.components.find((component) => component.symbol === "lowercase")
        ?.exported,
      true,
    );
  });

  it("follows nested local render helpers into atoms and private components", () => {
    const fixture = fixtureProject({
      "components/ui/table.tsx":
        "export function TableHead() { return <th />; }",
      "components/composites/MarkdownText.tsx": [
        "import { TableHead } from '../ui/table';",
        "function unreachableDecoration() { return <aside className='bg-card shadow-sm' />; }",
        "function CodeBlock() { return <div className='rounded-sm border bg-card' />; }",
        "function renderBlock() { return <><blockquote className='border-l-2' /><TableHead className='border bg-card' /><CodeBlock /></>; }",
        "function renderToken() { return renderBlock(); }",
        "export function MarkdownText() { return renderToken(); }",
      ].join("\n"),
    });
    const tableFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/table.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${tableFile}#TableHead`, "table-head"]]),
      sourceRoot: fixture.root,
    });
    const markdownText = graph.components.find(
      (component) => component.symbol === "MarkdownText",
    );
    assert.ok(markdownText, "a helper-rendered component must be discovered");
    assert.deepEqual(markdownText.directAtoms, ["table-head"]);
    assert.deepEqual(markdownText.dependencies, [
      "packages/ui/src/components/composites/MarkdownText.tsx#CodeBlock",
      "packages/ui/src/components/ui/table.tsx#TableHead",
    ]);
    assert.deepEqual(markdownText.rawCapabilities, [
      {
        capabilities: ["paint.border"],
        file: "packages/ui/src/components/composites/MarkdownText.tsx",
        host: "blockquote",
        line: 4,
      },
      {
        capabilities: ["paint.border", "paint.surface"],
        file: "packages/ui/src/components/composites/MarkdownText.tsx",
        host: "TableHead",
        line: 4,
      },
    ]);
    assert.deepEqual(
      graph.components.find((component) => component.symbol === "CodeBlock")
        ?.rawCapabilities[0]?.capabilities,
      ["paint.border", "paint.radius", "paint.surface"],
    );
  });

  it("extracts raw hosts from React.createElement and its imported alias", () => {
    const fixture = fixtureProject({
      "components/composites/Factories.tsx": [
        "import React, { createElement as h } from 'react';",
        "function renderSurface() { return React.createElement('section', { className: 'rounded-lg bg-card' }); }",
        "function renderAction() { return h('button', { type: 'button' }); }",
        "export function FactoryCard() { return [renderSurface(), renderAction()]; }",
      ].join("\n"),
      "components/composites/Lookalike.tsx": [
        "import { createElement as h } from './not-react';",
        "export function Lookalike() { return h('button', { className: 'bg-card' }); }",
      ].join("\n"),
      "components/composites/LocalReact.tsx": [
        "const React = { createElement: (...values: unknown[]) => values };",
        "export function LocalReact() { return React.createElement('button', { className: 'bg-card' }); }",
      ].join("\n"),
      "components/composites/not-react.ts":
        "export function createElement(...values: unknown[]) { return values; }",
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });
    const factoryCard = graph.components.find(
      (component) => component.symbol === "FactoryCard",
    );
    assert.deepEqual(factoryCard?.rawCapabilities, [
      {
        capabilities: ["paint.radius", "paint.surface"],
        file: "packages/ui/src/components/composites/Factories.tsx",
        host: "section",
        line: 2,
      },
      {
        capabilities: ["interaction.activate"],
        file: "packages/ui/src/components/composites/Factories.tsx",
        host: "button",
        line: 3,
      },
    ]);
    assert.equal(
      graph.components.some((component) =>
        ["LocalReact", "Lookalike"].includes(component.symbol),
      ),
      false,
      "same-named local and imported factories are not React rendering",
    );
  });

  it("resolves destructured and bracket-access React createElement aliases", () => {
    const fixture = fixtureProject({
      "components/composites/FactoryAliases.ts": [
        "import React from 'react';",
        "const { createElement: h } = React;",
        "const bracketFactory = React['createElement'];",
        "export function DestructuredFactory() { return h('section', { className: 'rounded-lg bg-card' }); }",
        "export const BracketFactory = () => bracketFactory('button', { type: 'button' });",
      ].join("\n"),
      "components/composites/LookalikeAliases.ts": [
        "const LocalReact = { createElement: (...values: unknown[]) => values };",
        "const { createElement: h } = LocalReact;",
        "const bracketFactory = LocalReact['createElement'];",
        "export function DestructuredLookalike() { return h('button', { className: 'bg-card' }); }",
        "export function BracketLookalike() { return bracketFactory('button', { className: 'bg-card' }); }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });

    assert.deepEqual(
      graph.components.map((component) => component.symbol).sort(),
      ["BracketFactory", "DestructuredFactory"],
    );
    assert.deepEqual(
      graph.components.find(
        (component) => component.symbol === "DestructuredFactory",
      )?.rawCapabilities[0]?.capabilities,
      ["paint.radius", "paint.surface"],
    );
    assert.deepEqual(
      graph.components.find(
        (component) => component.symbol === "BracketFactory",
      )?.rawCapabilities[0]?.capabilities,
      ["interaction.activate"],
    );
  });

  it("keeps createElement slot exemptions limited to literal true", () => {
    const fixture = fixtureProject({
      "components/ui/button.tsx":
        "export function Button() { return <button type='button' />; }",
      "components/composites/FactorySlots.tsx": [
        "import React from 'react';",
        "import { Button } from '../ui/button';",
        "declare const uncertain: boolean;",
        "export function CertainSlot() { return React.createElement(Button, { asChild: true }, React.createElement('a', { href: '/ok' })); }",
        "export function FalseSlot() { return React.createElement(Button, { asChild: false }, React.createElement('a', { href: '/next' })); }",
        "export function UncertainSlot() { return React.createElement(Button, { asChild: uncertain }, React.createElement('a', { href: '/later' })); }",
      ].join("\n"),
    });
    const buttonFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/button.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${buttonFile}#Button`, "button"]]),
    });
    assert.deepEqual(
      graph.components.find((component) => component.symbol === "CertainSlot")
        ?.rawCapabilities,
      [],
    );
    for (const symbol of ["FalseSlot", "UncertainSlot"]) {
      assert.deepEqual(
        graph.components.find((component) => component.symbol === symbol)
          ?.rawCapabilities[0]?.capabilities,
        ["interaction.activate"],
        symbol,
      );
    }
  });

  it("resolves nested helper-returned spreads and function recipes", () => {
    const fixture = fixtureProject({
      "components/composites/HelperSpread.tsx": [
        "function surfaceRecipe() { return 'rounded-lg border bg-card shadow-sm'; }",
        "function visualStyle() { return { borderRadius: 8 }; }",
        "function baseProps() { return { className: surfaceRecipe(), style: visualStyle() }; }",
        "function interactiveProps() { return { ...baseProps(), onClick: () => undefined }; }",
        "function unusedProps() { return { className: 'bg-danger' }; }",
        "export function HelperSpread() { return <div {...interactiveProps()} />; }",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
    });
    assert.deepEqual(graph.components[0]?.rawCapabilities[0]?.capabilities, [
      "interaction.activate",
      "paint.border",
      "paint.elevation",
      "paint.radius",
      "paint.surface",
    ]);
  });

  it("follows canonical atoms through the @elizaos/ui package root", () => {
    const fixture = fixtureProject({
      "index.ts": "export { Card } from './components/ui/card';",
      "components/ui/card.tsx":
        "export function Card() { return <section className='rounded-sm bg-card' />; }",
      "components/composites/PackageRootConsumer.tsx": [
        "import { Card } from '@elizaos/ui';",
        "export function PackageRootConsumer() { return <Card>Owned</Card>; }",
      ].join("\n"),
    });
    const cardFile = path.join(
      fixture.root,
      "packages/ui/src/components/ui/card.tsx",
    );
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map([[`${cardFile}#Card`, "card"]]),
      sourceRoot: fixture.root,
    });

    const consumer = graph.components.find(
      (component) => component.symbol === "PackageRootConsumer",
    );
    assert.deepEqual(consumer?.directAtoms, ["card"]);
    assert.deepEqual(consumer?.transitiveAtoms, ["card"]);
    assert.deepEqual(consumer?.dependencies, [
      "packages/ui/src/components/ui/card.tsx#Card",
    ]);
  });

  it("discovers createElement components in .ts and follows property helpers", () => {
    const fixture = fixtureProject({
      "components/composites/PropertyHelpers.ts": [
        "import React from 'react';",
        "const helpers = {",
        "  props() { return { className: 'rounded-lg bg-card', onClick: () => undefined }; },",
        "};",
        "export function PropertyHelperSurface() {",
        "  return React.createElement('section', helpers.props());",
        "}",
      ].join("\n"),
    });
    const graph = discoverComponentGraph({
      absoluteFiles: fixture.absoluteFiles,
      atomOwnerByKey: new Map(),
      sourceRoot: fixture.root,
    });

    assert.deepEqual(graph.components[0]?.rawCapabilities, [
      {
        capabilities: ["interaction.activate", "paint.radius", "paint.surface"],
        file: "packages/ui/src/components/composites/PropertyHelpers.ts",
        host: "section",
        line: 6,
      },
    ]);
  });
});
