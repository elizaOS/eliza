# Payment Scenarios Test Suite

This directory contains comprehensive scenario tests for the ElizaOS payment system, testing various payment flows, edge cases, and multi-agent interactions.

## Overview

The payment scenarios test the integration of the `@elizaos/plugin-payment` with other plugins to ensure robust payment processing, proper error handling, and seamless user experience.

## Scenarios

### 60. Basic Payment Flow (`60-payment-basic-flow.ts`)

Tests fundamental payment functionality including:

- Service pricing communication
- Payment processing for research services
- Balance checking
- Service delivery after payment
- Multiple service tiers (1, 5, and 10 USDC)

### 61. Trust and Role Exemptions (`61-payment-trust-exemptions.ts`)

Tests payment exemptions based on user roles and trust levels:

- Admin/Owner role exemptions
- High-trust user discounts (50% for trust > 80)
- Regular user payment requirements
- Role-based access control integration

### 62. Payment Confirmation Flow (`62-payment-confirmation-flow.ts`)

Tests the AWAITING_CHOICE task system for payment confirmations:

- High-value transaction confirmations
- Task creation for payment approval
- APPROVE/REJECT handling
- Value proposition explanation before payment
- Integration with the task/choice system

### 63. Insufficient Funds Handling (`63-payment-insufficient-funds.ts`)

Tests graceful handling of payment failures:

- Insufficient balance detection
- Clear error messaging
- Alternative payment options
- Service degradation (offering cheaper alternatives)
- Payment method suggestions

### 64. Multi-Currency and Auto-Liquidation (`64-payment-multi-currency.ts`)

Tests payment processing in multiple cryptocurrencies:

- USDC, ETH, SOL, MATIC, ARB support
- Auto-liquidation to USDC
- Currency conversion rates
- Payment priority (USDC > ETH > SOL > others)
- Custodial wallet management

### 65. Multi-Agent Payment Collaboration (`65-payment-multi-agent.ts`)

Tests complex payment flows between multiple agents:

- Collaborative service offerings
- Revenue sharing (60/40 split)
- Inter-agent transfers
- Payment transparency
- Audit trail maintenance

## Running the Scenarios

### Individual Scenario

```bash
cd packages/cli
npx elizaos scenario ./scenarios/plugin-tests/60-payment-basic-flow.ts --verbose
```

### All Payment Scenarios

```bash
cd packages/cli/scripts
chmod +x test-payment-scenarios.sh
./test-payment-scenarios.sh
```

### With Custom Character

```bash
npx elizaos scenario ./scenarios/plugin-tests/60-payment-basic-flow.ts \
  --character ./scenarios/plugin-tests/payment-test-character.json \
  --verbose
```

## Payment Configuration

The payment system can be configured through agent settings:

```json
{
  "payment": {
    "enabled": true,
    "autoApprovalThreshold": "5.00",
    "requireConfirmation": true,
    "trustThreshold": 70,
    "maxDailySpend": "1000.00",
    "preferredCurrency": "USDC",
    "autoLiquidation": {
      "enabled": true,
      "targetCurrency": "USDC_ETH",
      "threshold": "10.00",
      "interval": 3600000
    }
  }
}
```

## Key Features Tested

1. **Payment Processing**

   - Balance checking
   - Transaction execution
   - Receipt generation
   - Error handling

2. **Trust Integration**

   - Role-based exemptions
   - Trust score discounts
   - Permission verification

3. **Multi-Currency Support**

   - Currency acceptance
   - Auto-liquidation
   - Conversion rates
   - Priority handling

4. **Confirmation Flows**

   - AWAITING_CHOICE tasks
   - User approval/rejection
   - Timeout handling

5. **Error Recovery**
   - Insufficient funds
   - Failed transactions
   - Network errors
   - Alternative options

## Expected Outcomes

Each scenario includes specific verification rules that check:

- Proper communication of pricing
- Correct payment processing
- Appropriate error handling
- Service delivery after payment
- Trust and role recognition

## Integration Points

The payment scenarios test integration with:

- `@elizaos/plugin-trust` - Role and trust verification
- `@elizaos/plugin-tasks` - Confirmation workflows
- `@elizaos/plugin-evm` - Ethereum payments
- `@elizaos/plugin-solana` - Solana payments
- `@elizaos/plugin-agentkit` - Custodial wallets
- `@elizaos/plugin-research` - Paid services

## Troubleshooting

### Common Issues

1. **Payment Service Not Found**

   - Ensure `@elizaos/plugin-payment` is installed
   - Check that the payment plugin is enabled in agent config

2. **Insufficient Funds Errors**

   - Verify test wallet has sufficient balance
   - Check correct network configuration

3. **Confirmation Timeouts**

   - Ensure task service is running
   - Check AWAITING_CHOICE task creation

4. **Currency Conversion Failures**
   - Verify price oracle service is available
   - Check network connectivity

## Future Enhancements

- Subscription payment scenarios
- Recurring billing tests
- Refund processing scenarios
- Payment plan negotiations
- Cross-chain payment routing
- Escrow service testing

## Contributing

When adding new payment scenarios:

1. Follow the existing naming convention (6X-payment-\*.ts)
2. Include comprehensive verification rules
3. Test both success and failure paths
4. Document expected outcomes
5. Update this README

## Related Documentation

- [Payment Plugin Documentation](../../../plugin-payment/README.md)
- [Trust System Documentation](../../../plugin-trust/README.md)
- [Task System Documentation](../../../plugin-tasks/README.md)
- [Scenario Testing Guide](../../README.md)
