import { describe, it, expect } from 'vitest';
import arbitragePlugin from '../src/index';
import { executeArbitrageAction } from '../src/actions/arbitrageAction';
import { marketProvider } from '../src/providers/marketProvider';
import { ArbitrageService } from '../src/services/ArbitrageService';

describe('arbitragePlugin', () => {
    it('should have correct name and description', () => {
        expect(arbitragePlugin.name).toBe('arbitrage-plugin');
        expect(arbitragePlugin.description).toBe('Automated arbitrage trading plugin');
    });

    it('should register the correct action', () => {
        expect(arbitragePlugin.actions).toContain(executeArbitrageAction);
    });

    it('should register the correct provider', () => {
        expect(arbitragePlugin.providers).toContain(marketProvider);
    });

    it('should register the arbitrage service', () => {
        expect(arbitragePlugin.services.length).toBe(1);
        expect(arbitragePlugin.services[0]).toBeInstanceOf(ArbitrageService);
    });
});
