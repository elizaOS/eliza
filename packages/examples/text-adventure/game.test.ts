/**
 * Bun tests for the deterministic text-adventure game engine.
 */
import { expect, test } from "bun:test";
import { AdventureGame, playScriptedAdventure } from "./game";

test("the local game engine exposes deterministic actions", () => {
  const game = new AdventureGame();

  expect(game.getCurrentRoom().id).toBe("entrance");
  expect(game.getAvailableActions()).toContain("take rusty torch");

  const blocked = game.executeAction("go north");
  expect(blocked).toContain("Torch-lit Hallway");
  expect(game.getAvailableActions()).toContain("attack");
  expect(game.executeAction("go north")).toContain("blocks your path");
});

test("a scripted no-LLM run can complete the dungeon", () => {
  const finalState = playScriptedAdventure([
    "take rusty torch",
    "go north",
    "attack",
    "attack",
    "go east",
    "take ancient sword",
    "take health potion",
    "go west",
    "go north",
    "attack with sword",
    "attack with sword",
    "go west",
    "take golden key",
    "go east",
    "go north",
    "attack with sword",
    "attack with sword",
    "use health potion",
    "attack with sword",
  ]);

  expect(finalState.gameOver).toBe(true);
  expect(finalState.victory).toBe(true);
  expect(finalState.score).toBeGreaterThanOrEqual(350);
  expect(finalState.health).toBeGreaterThan(0);
});
