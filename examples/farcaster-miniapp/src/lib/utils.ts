export function formatNumber(value: number | string, decimals: number = 2): string {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (isNaN(num)) return '0'

    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(decimals) + 'M'
    } else if (num >= 1_000) {
        return (num / 1_000).toFixed(decimals) + 'K'
    }

    return num.toFixed(decimals)
}

export function formatCurrency(value: number | string, currency: string = 'USD'): string {
    const num = typeof value === 'string' ? parseFloat(value) : value
    if (isNaN(num)) return '$0.00'

    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(num)
}

export function formatAddress(address: string, chars: number = 4): string {
    if (!address) return ''
    if (address.length <= chars * 2) return address

    return `${address.slice(0, chars)}...${address.slice(-chars)}`
}

export function formatTimeAgo(timestamp: string | number): string {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp)
    const now = new Date()
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`

    return date.toLocaleDateString()
}

export function parseTokenAmount(amount: string, decimals: number): string {
    try {
        const num = parseFloat(amount)
        if (isNaN(num)) return '0'

        return (num * Math.pow(10, decimals)).toString()
    } catch {
        return '0'
    }
}

export function formatTokenAmount(amount: string, decimals: number): string {
    try {
        const num = parseFloat(amount)
        if (isNaN(num)) return '0'

        return (num / Math.pow(10, decimals)).toFixed(decimals > 6 ? 6 : decimals)
    } catch {
        return '0'
    }
}

export function calculatePriceImpact(inputAmount: string, outputAmount: string, expectedOutput: string): string {
    try {
        const input = parseFloat(inputAmount)
        const output = parseFloat(outputAmount)
        const expected = parseFloat(expectedOutput)

        if (isNaN(input) || isNaN(output) || isNaN(expected) || expected === 0) {
            return '0'
        }

        const impact = ((expected - output) / expected) * 100
        return impact.toFixed(2)
    } catch {
        return '0'
    }
}

export function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard) {
        return navigator.clipboard.writeText(text)
    }

    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)

    return Promise.resolve()
}

