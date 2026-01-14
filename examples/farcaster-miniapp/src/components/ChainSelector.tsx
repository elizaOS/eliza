import type { Chain } from '../types'

interface ChainSelectorProps {
    chains: Chain[]
    selectedChain: string
    onSelect: (chainId: string) => void
    label?: string
}

export function ChainSelector({ chains, selectedChain, onSelect, label }: ChainSelectorProps) {
    return (
        <div className="chain-selector">
            {label && <label className="selector-label">{label}</label>}
            <div className="selector-dropdown">
                <select
                    value={selectedChain}
                    onChange={(e) => onSelect(e.target.value)}
                    className="chain-select"
                >
                    {chains.map((chain) => (
                        <option key={chain.id} value={chain.id}>
                            {chain.icon} {chain.name}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    )
}

