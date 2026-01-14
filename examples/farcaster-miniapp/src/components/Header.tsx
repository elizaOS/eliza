import { formatAddress } from '../lib/utils'
import type { User, WalletAddresses } from '../types'

interface HeaderProps {
    user: User | null
    addresses: WalletAddresses | null
}

export function Header({ user, addresses }: HeaderProps) {
    return (
        <header className="app-header">
            <div className="header-content">
                <div className="header-logo">
                    <span className="logo-icon">🤖</span>
                    <h1 className="logo-text">Eliza</h1>
                </div>

                {user && addresses && (
                    <div className="header-user">
                        <div className="user-info">
                            <span className="user-fid">@{user.username || `fid:${user.fid}`}</span>
                            <div className="user-addresses">
                                <div className="address-item" title={addresses.solana}>
                                    <span className="address-chain">◎</span>
                                    <span className="address-text">{formatAddress(addresses.solana)}</span>
                                </div>
                                <div className="address-item" title={addresses.evm}>
                                    <span className="address-chain">Ξ</span>
                                    <span className="address-text">{formatAddress(addresses.evm)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </header>
    )
}

