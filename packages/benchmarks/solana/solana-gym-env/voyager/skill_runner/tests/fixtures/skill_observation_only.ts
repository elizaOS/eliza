/**
 * Test fixture: Observation-only skill that doesn't create a transaction
 * Verifies that skills can return null when no blockchain interaction is needed
 */
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
    
    // Just observe wallet balances, no transaction needed
    const balances = wallet.balances;
    const hasEnoughSOL = balances[0] > 1.0;
    
    return [
        hasEnoughSOL ? 0.5 : 0.0,
        hasEnoughSOL ? "sufficient_balance" : "insufficient_balance",
        null  // No transaction
    ];
}