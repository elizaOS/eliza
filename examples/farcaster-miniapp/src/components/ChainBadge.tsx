import { getChainIcon, getChainName } from '../lib/chains'

interface ChainBadgeProps {
    chainId: string
    showName?: boolean
    size?: 'small' | 'medium' | 'large'
}

export function ChainBadge({ chainId, showName = true, size = 'medium' }: ChainBadgeProps) {
    const icon = getChainIcon(chainId)
    const name = getChainName(chainId)

    return (
        <div className={`chain-badge chain-badge-${size}`}>
            <span className="badge-icon">{icon}</span>
            {showName && <span className="badge-name">{name}</span>}
        </div>
    )
}

