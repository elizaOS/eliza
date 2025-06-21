#!/bin/bash

# Test payment scenarios using elizaos scenario command

echo "Building the CLI..."
cd ../..
npm run build:cli
cd packages/cli

echo ""
echo "=========================================="
echo "Testing Payment Scenarios"
echo "=========================================="
echo ""

# Basic Payment Flow
echo "Test 1: Basic Payment Flow"
echo "-------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/60-payment-basic-flow.ts --verbose
echo ""

# Trust-Based Exemptions
echo "Test 2: Trust and Role Exemptions"
echo "---------------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/61-payment-trust-exemptions.ts --verbose
echo ""

# Payment Confirmation Flow
echo "Test 3: Payment Confirmation Flow"
echo "---------------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/62-payment-confirmation-flow.ts --verbose
echo ""

# Insufficient Funds
echo "Test 4: Insufficient Funds Handling"
echo "-----------------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/63-payment-insufficient-funds.ts --verbose
echo ""

# Multi-Currency Payments
echo "Test 5: Multi-Currency and Auto-Liquidation"
echo "-------------------------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/64-payment-multi-currency.ts --verbose
echo ""

# Multi-Agent Collaboration
echo "Test 6: Multi-Agent Payment Collaboration"
echo "-----------------------------------------"
npx elizaos scenario run --scenario ./scenarios/plugin-tests/65-payment-multi-agent.ts --verbose
echo ""

echo "=========================================="
echo "Payment Scenario Tests Complete!"
echo "==========================================" 