interface ElizaLogoProps {
  className?: string;
}

export function ElizaLogo({ className }: ElizaLogoProps) {
  return <img src="/eliza-logo.png" alt="Eliza" className={className} />;
}
