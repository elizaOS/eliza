// spec/cloud/identity/secondFactor.md, "A TOTP code is accepted only within one step of now and at a later step than the last one accepted"
import { createHmac } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const stepMs = 30_000;

function base32Bytes(secret: string): Buffer {
  const bits = [...secret].map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
}

export function authenticatorCode(secret: string, at: number, stepsAhead = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / stepMs) + stepsAhead));
  const mac = createHmac("sha1", base32Bytes(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
