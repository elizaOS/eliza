import { describe, expect, it } from 'bun:test';
import {
  createSettingFromConfig,
  encryptStringValue,
  decryptStringValue,
  saltSettingValue,
  unsaltSettingValue,
  saltWorldSettings,
  unsaltWorldSettings,
} from '../settings';
import { getSalt } from '../settings';

describe('settings utilities', () => {
  it('createSettingFromConfig copies fields', () => {
    const cfg = { name: 'a', description: 'd', required: true } as any;
    const setting = createSettingFromConfig(cfg);
    expect(setting.name).toBe('a');
    expect(setting.required).toBe(true);
    expect(setting.value).toBeNull();
  });

  it('encrypt/decrypt round trip', () => {
    const salt = getSalt();
    const enc = encryptStringValue('secret', salt);
    expect(enc).not.toBe('secret');
    const dec = decryptStringValue(enc, salt);
    expect(dec).toBe('secret');
  });

  it('salt and unsalt setting value', () => {
    const salt = getSalt();
    const setting = { value: 'v', secret: true } as any;
    const salted = saltSettingValue(setting, salt);
    expect(salted.value).not.toBe('v');
    const unsalted = unsaltSettingValue(salted, salt);
    expect(unsalted.value).toBe('v');
  });

  it('salt and unsalt world settings', () => {
    const salt = getSalt();
    const world = { a: { value: 'x', secret: true } } as any;
    const salted = saltWorldSettings(world, salt);
    expect(salted.a.value).not.toBe('x');
    const unsalted = unsaltWorldSettings(salted, salt);
    expect(unsalted.a.value).toBe('x');
  });
});
