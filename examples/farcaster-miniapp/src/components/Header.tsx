interface HeaderProps {
    title?: string
    subtitle?: string
}

export function Header({ title = 'Eliza', subtitle = 'Classic Chat (in-memory)' }: HeaderProps) {
    return (
        <header className="app-header">
            <div className="header-content">
                <div className="header-logo">
                    <span className="logo-icon">🤖</span>
                    <div className="logo-text-block">
                        <h1 className="logo-text">{title}</h1>
                        <div className="logo-subtitle">{subtitle}</div>
                    </div>
                </div>
            </div>
        </header>
    )
}

