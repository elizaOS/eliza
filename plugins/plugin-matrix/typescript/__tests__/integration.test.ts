import { describe, expect, test } from "bun:test";
import matrixPlugin, {
  MatrixService,
  joinRoom,
  listRooms,
  roomStateProvider,
  sendMessage,
  sendReaction,
  userContextProvider,
} from "../src/index.ts";

describe("Matrix plugin exports", () => {
  test("exports plugin metadata", () => {
    expect(matrixPlugin.name).toBe("matrix");
    expect(matrixPlugin.description).toContain("Matrix");
    expect(Array.isArray(matrixPlugin.actions)).toBe(true);
    expect(Array.isArray(matrixPlugin.providers)).toBe(true);
    expect(Array.isArray(matrixPlugin.services)).toBe(true);
  });

  test("exports actions, providers, and service", () => {
    expect(sendMessage).toBeDefined();
    expect(sendReaction).toBeDefined();
    expect(listRooms).toBeDefined();
    expect(joinRoom).toBeDefined();
    expect(roomStateProvider).toBeDefined();
    expect(userContextProvider).toBeDefined();
    expect(MatrixService).toBeDefined();
  });
});
