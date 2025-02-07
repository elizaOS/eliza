export default function PageTitle({
    title,
    subtitle,
}: {
    title: string;
    subtitle?: string;
}) {
    return (
        <div className="space-y-0.5">
            <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
            {subtitle ? (
                <p className="text-muted-foreground">{subtitle}</p>
            ) : null}
        </div>
    );
}
