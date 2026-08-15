/**
 * Deterministically exercises managed command registration, canonical owner
 * authorization, real channel validation, fresh receive subscription, and the
 * Cloud turn/audio bridge without a Discord account or model provider.
 */

import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { EndBehaviorType } from "@discordjs/voice";
import { Collection, Events, PermissionFlagsBits } from "discord.js";
import {
  MANAGED_VOICE_COMMAND,
  ManagedGuildVoiceController,
  pcmToWav,
} from "../src/managed-guild-voice";

function clientHarness() {
  const emitter = new EventEmitter();
  const create = mock(async () => undefined);
  const edit = mock(async () => undefined);
  return {
    client: Object.assign(emitter, {
      application: {
        commands: {
          fetch: mock(async () => new Collection()),
          create,
          edit,
        },
      },
      user: { id: "1474591626759376967" },
    }),
    create,
    edit,
  };
}

function interactionHarness(
  subcommand: "join" | "leave",
  userId = "111111111111111",
) {
  const reply = mock(async () => undefined);
  const deferReply = mock(async () => undefined);
  const editReply = mock(async () => undefined);
  const channel = {
    id: "333333333333333",
    name: "Eliza voice",
    guild: { id: "222222222222222", voiceAdapterCreator: {} },
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: "222222222222222",
    members: {
      me: { id: "1474591626759376967" },
      fetch: mock(async () => ({ displayName: "Owner", voice: { channel } })),
    },
  };
  channel.guild = Object.assign(guild, { voiceAdapterCreator: {} });
  return {
    interaction: {
      isChatInputCommand: () => true,
      commandName: "voice",
      guild,
      guildId: guild.id,
      user: { id: userId, username: "owner" },
      memberPermissions: {
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.ManageGuild,
      },
      options: { getSubcommand: () => subcommand },
      reply,
      deferReply,
      editReply,
      deferred: false,
      replied: false,
    },
    channel,
    reply,
    deferReply,
    editReply,
  };
}

describe("ManagedGuildVoiceController", () => {
  test("registers one guild-install-only voice command", async () => {
    const harness = clientHarness();
    const controller = new ManagedGuildVoiceController({
      client: harness.client as never,
      bridge: {
        authorize: mock(async () => ({ allowed: true })),
        turn: mock(),
      },
    });
    await controller.start();
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create.mock.calls[0]?.[0]).toEqual(MANAGED_VOICE_COMMAND);
    expect(MANAGED_VOICE_COMMAND.options.map((option) => option.name)).toEqual([
      "join",
      "leave",
    ]);
    await controller.stop();
  });

  test("Discord ManageGuild never bypasses canonical Cloud ownership", async () => {
    const harness = clientHarness();
    const join = mock();
    const controller = new ManagedGuildVoiceController({
      client: harness.client as never,
      bridge: {
        authorize: mock(async () => ({ allowed: false, reason: "not_owner" })),
        turn: mock(),
      },
      join,
    });
    await controller.start();
    const command = interactionHarness("join");
    harness.client.emit(Events.InteractionCreate, command.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(join).not.toHaveBeenCalled();
    expect(command.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("canonical owner"),
      }),
    );
    await controller.stop();
  });

  test("joins only the invoker channel and consumes a fresh empty receive stream", async () => {
    const harness = clientHarness();
    const speaking = new EventEmitter();
    const receive = new PassThrough();
    expect(receive.readableLength).toBe(0);
    const destroy = mock();
    const connection = Object.assign(new EventEmitter(), {
      receiver: {
        speaking,
        subscribe: mock(() => receive),
      },
      destroy,
    });
    const join = mock(() => connection);
    const turn = mock(async () => ({
      transcript: "hello",
      replyText: "hi",
      audioBase64: Buffer.from("mp3").toString("base64"),
      audioContentType: "audio/mpeg",
    }));
    const play = mock(async () => undefined);
    const waitForReady = mock(async () => connection);
    const controller = new ManagedGuildVoiceController({
      client: harness.client as never,
      bridge: { authorize: mock(async () => ({ allowed: true })), turn },
      join: join as never,
      waitForReady: waitForReady as never,
      decode: (stream) => stream,
      play,
    });
    await controller.start();
    const command = interactionHarness("join");
    harness.client.emit(Events.InteractionCreate, command.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(join).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: command.interaction.guildId,
        channelId: command.channel.id,
        selfDeaf: false,
      }),
    );
    speaking.emit("start", command.interaction.user.id);
    expect(connection.receiver.subscribe).toHaveBeenCalledWith(
      command.interaction.user.id,
      expect.objectContaining({
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      }),
    );
    receive.end(Buffer.from([1, 0, 2, 0]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turn).toHaveBeenCalledTimes(1);
    const request = turn.mock.calls[0]?.[0];
    expect(
      Buffer.from(request.wavBase64, "base64").subarray(0, 4).toString(),
    ).toBe("RIFF");
    expect(play).toHaveBeenCalledTimes(1);

    connection.emit("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitForReady).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();

    const leave = interactionHarness("leave");
    harness.client.emit(Events.InteractionCreate, leave.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  test("WAV wrapper describes the subscribed PCM bytes", () => {
    const wav = pcmToWav(Buffer.from([1, 0, 2, 0]));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.readUInt32LE(24)).toBe(16_000);
  });
});
