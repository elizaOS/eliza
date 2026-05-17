import ElizaMacCore
import SwiftUI

struct WalletsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Wallets",
                    subtitle: "Runtime wallet, Steward vault, signing, RPC, and balance readiness from the elizaOS API.",
                    systemImage: "wallet.pass"
                )

                actionCard

                if let result = model.lastNativeActionResult {
                    GlassCard {
                        Label(result, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }

                if let error = model.lastWalletProbeError {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Wallet probe failed", systemImage: "exclamationmark.triangle")
                                .font(.headline)
                                .foregroundStyle(theme.destructiveTint)
                            Text(error)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }

                if let snapshot = model.walletSnapshot {
                    signingCard(snapshot)
                    addressesCard(snapshot)
                    rpcCard(snapshot)
                    balancesCard(snapshot)
                    stewardCard(snapshot.steward)
                    walletEntriesCard(snapshot.config.wallets)
                } else {
                    EmptyStateView(
                        title: "No wallet telemetry yet",
                        detail: "Start or refresh the runtime to read /api/wallet/config, /api/wallet/addresses, /api/wallet/balances, and Steward status.",
                        systemImage: "wallet.pass"
                    )
                }
            }
            .padding(24)
        }
        .navigationTitle("Wallets")
        .toolbar {
            ToolbarItem {
                Button {
                    model.refreshWalletSnapshot()
                } label: {
                    Label("Refresh Wallets", systemImage: "arrow.clockwise")
                }
                .disabled(model.isRefreshingWallet)
            }
        }
        .task {
            if model.walletSnapshot == nil && !model.isRefreshingWallet {
                model.refreshWalletSnapshot()
            }
        }
    }

    private var actionCard: some View {
        GlassCard {
            HStack(spacing: 10) {
                Button {
                    model.refreshWalletSnapshot()
                } label: {
                    Label(model.isRefreshingWallet ? "Refreshing" : "Refresh Wallets", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isRefreshingWallet)

                Button {
                    model.openWalletRenderer()
                } label: {
                    Label("Open Wallet App", systemImage: "macwindow")
                }
                .buttonStyle(.bordered)

                Button {
                    model.openStewardApp()
                } label: {
                    Label("Open Steward", systemImage: "lock.shield")
                }
                .buttonStyle(.bordered)

                Spacer()

                StatusPill(
                    title: model.walletSnapshot?.config.executionReady == true ? "Execution Ready" : "Needs Review",
                    systemImage: model.walletSnapshot?.config.executionReady == true ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                    tint: model.walletSnapshot?.config.executionReady == true ? theme.primaryTint : theme.warningTint
                )
            }
        }
    }

    private func signingCard(_ snapshot: WalletRuntimeSnapshot) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Signing and Execution", systemImage: "signature")
                        .font(.headline)
                    Spacer()
                    StatusPill(
                        title: snapshot.config.executionReady == true ? "Ready" : "Blocked",
                        systemImage: snapshot.config.executionReady == true ? "checkmark.circle.fill" : "xmark.octagon.fill",
                        tint: snapshot.config.executionReady == true ? theme.primaryTint : theme.warningTint
                    )
                }

                DetailGrid(rows: [
                    ("Wallet source", display(snapshot.config.walletSource)),
                    ("Network", display(snapshot.config.walletNetwork)),
                    ("Automation", display(snapshot.config.automationMode)),
                    ("EVM signer", display(snapshot.config.evmSigningCapability)),
                    ("Signer reason", display(snapshot.config.evmSigningReason)),
                    ("Solana signing", yesNo(snapshot.config.solanaSigningAvailable)),
                    ("Trade mode", display(snapshot.config.tradePermissionMode)),
                    ("Blocked reason", display(snapshot.config.executionBlockedReason))
                ])
            }
        }
    }

    private func addressesCard(_ snapshot: WalletRuntimeSnapshot) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Addresses", systemImage: "number")
                    .font(.headline)

                DetailGrid(rows: [
                    ("EVM", address(snapshot.addresses.evmAddress)),
                    ("Solana", address(snapshot.addresses.solanaAddress)),
                    ("Primary EVM", display(snapshot.config.primary?.evm)),
                    ("Primary Solana", display(snapshot.config.primary?.solana)),
                    ("Cloud access", yesNo(snapshot.config.cloudManagedAccess)),
                    ("Wallet entries", count(snapshot.config.wallets?.count))
                ])
            }
        }
    }

    private func rpcCard(_ snapshot: WalletRuntimeSnapshot) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("RPC and Balance Readiness", systemImage: "network")
                    .font(.headline)

                DetailGrid(rows: [
                    ("EVM RPC", display(snapshot.config.selectedRpcProviders?.evm)),
                    ("BSC RPC", display(snapshot.config.selectedRpcProviders?.bsc)),
                    ("Solana RPC", display(snapshot.config.selectedRpcProviders?.solana)),
                    ("EVM chains", joined(snapshot.config.evmChains)),
                    ("Alchemy key", yesNo(snapshot.config.alchemyKeySet)),
                    ("Infura key", yesNo(snapshot.config.infuraKeySet)),
                    ("Ankr key", yesNo(snapshot.config.ankrKeySet)),
                    ("Helius key", yesNo(snapshot.config.heliusKeySet)),
                    ("Birdeye key", yesNo(snapshot.config.birdeyeKeySet)),
                    ("BSC managed", yesNo(snapshot.config.managedBscRpcReady)),
                    ("EVM balances", yesNo(snapshot.config.evmBalanceReady)),
                    ("Solana balances", yesNo(snapshot.config.solanaBalanceReady))
                ])
            }
        }
    }

    private func balancesCard(_ snapshot: WalletRuntimeSnapshot) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Balances", systemImage: "chart.bar.xaxis")
                    .font(.headline)

                DetailGrid(rows: [
                    ("EVM address", address(snapshot.balances.evm?.address)),
                    ("EVM chains", count(snapshot.balances.evm?.chains.count)),
                    ("Solana address", address(snapshot.balances.solana?.address)),
                    ("SOL", display(snapshot.balances.solana?.solBalance)),
                    ("SOL USD", display(snapshot.balances.solana?.solValueUsd)),
                    ("Solana tokens", count(snapshot.balances.solana?.tokens.count))
                ])

                if let chains = snapshot.balances.evm?.chains, !chains.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(chains) { chain in
                            HStack {
                                Text(chain.chain)
                                    .font(.subheadline.weight(.medium))
                                Spacer()
                                Text("\(chain.nativeBalance) \(chain.nativeSymbol)")
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                StatusPill(
                                    title: chain.error == nil ? "OK" : "Error",
                                    systemImage: chain.error == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                                    tint: chain.error == nil ? theme.primaryTint : theme.warningTint
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private func stewardCard(_ steward: StewardStatusSnapshot) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Steward", systemImage: "lock.shield")
                        .font(.headline)
                    Spacer()
                    StatusPill(
                        title: steward.connected ? "Connected" : "Offline",
                        systemImage: steward.connected ? "checkmark.circle.fill" : "xmark.circle.fill",
                        tint: steward.connected ? theme.primaryTint : theme.warningTint
                    )
                }

                DetailGrid(rows: [
                    ("Configured", yesNo(steward.configured)),
                    ("Available", yesNo(steward.available)),
                    ("Connected", yesNo(steward.connected)),
                    ("Vault health", display(steward.vaultHealth)),
                    ("Base URL", display(steward.baseUrl)),
                    ("Agent", display(steward.agentName)),
                    ("Agent ID", display(steward.agentId)),
                    ("EVM", address(steward.evmAddress ?? steward.walletAddresses?.evm)),
                    ("Solana", address(steward.walletAddresses?.solana)),
                    ("Error", display(steward.error))
                ])
            }
        }
    }

    @ViewBuilder
    private func walletEntriesCard(_ wallets: [WalletEntrySnapshot]?) -> some View {
        if let wallets, !wallets.isEmpty {
            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Registered Wallets", systemImage: "list.bullet.rectangle")
                        .font(.headline)

                    ForEach(wallets) { wallet in
                        HStack(spacing: 12) {
                            Image(systemName: wallet.chain == "solana" ? "sun.max" : "hexagon")
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(wallet.source) \(wallet.chain)")
                                    .font(.subheadline.weight(.medium))
                                Text(wallet.address)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .textSelection(.enabled)
                            }
                            Spacer()
                            StatusPill(
                                title: wallet.primary ? "Primary" : wallet.provider,
                                systemImage: wallet.primary ? "checkmark.circle.fill" : "circle",
                                tint: wallet.primary ? theme.primaryTint : theme.secondaryTint
                            )
                        }
                    }
                }
            }
        }
    }

    private func display(_ value: String?) -> String {
        guard let value, !value.isEmpty else {
            return "Not reported"
        }
        return value
    }

    private func address(_ value: String?) -> String {
        guard let value, !value.isEmpty else {
            return "Not configured"
        }

        guard value.count > 24 else {
            return value
        }

        return "\(value.prefix(10))...\(value.suffix(8))"
    }

    private func yesNo(_ value: Bool?) -> String {
        guard let value else {
            return "Not reported"
        }
        return value ? "Yes" : "No"
    }

    private func count(_ value: Int?) -> String {
        guard let value else {
            return "Not reported"
        }
        return "\(value)"
    }

    private func joined(_ values: [String]?) -> String {
        guard let values, !values.isEmpty else {
            return "Not reported"
        }
        return values.joined(separator: ", ")
    }
}
