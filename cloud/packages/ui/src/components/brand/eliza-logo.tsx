interface ElizaLogoProps {
  className?: string;
}

export function ElizaLogo({ className }: ElizaLogoProps) {
  return (
    <svg viewBox="0 0 60 15" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.97212 11.3345V9.43993L4.35013 9.06042H9.8477V5.77885H4.27275L3.97212 5.47674V3.5822L4.22512 3.3292H11.5845V0H0V14.9851H11.7973V11.6544H4.29061L3.97212 11.3345Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.7665 11.3374V0.0133936H12.723V14.9985H24.1869V11.6678H17.0984L16.7665 11.3374Z"
        fill="currentColor"
      />
      <path d="M29.0579 0.0133936H25.0144V15H29.0579V0.0133936Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M35.4142 11.2303L42.4521 3.15359V0.0133936H30.0119V3.34408H36.968V3.7474L29.939 11.9312V15H42.6411V11.6693H35.4142V11.2303Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M49.112 0.0133936L43.1412 15H47.2086L48.2191 12.3688L48.6894 12.0979H53.8387L54.2718 12.348L55.2942 14.9985H59.5997L53.6288 0.0133936H49.112ZM52.6213 9.07382H49.9157L49.6031 8.76129L51.078 4.64927H51.4248L52.913 8.78659L52.6213 9.07382Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* Original logo (wider aspect ratio):
export function ElizaLogoOriginal({ className }: ElizaLogoProps) {
  return (
    <svg
      viewBox="0 0 512 93.06"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M382.36,93.06L408.84.41l76.82.09,26.34,92.56h-55.62l-1.75-11.8-17.11.19-2.16,11.61h-53ZM439.51,72.52h13.36l-7.22-40.63-6.71,39.65.57.98Z" />
      <polygon points="104.68 0 104.68 31.46 50.37 31.46 50.37 38.45 102.93 38.45 102.93 55.92 51.02 55.92 50.37 56.58 50.37 62.91 105.55 62.91 105.55 93.06 0 93.06 0 0 104.68 0" />
      <polygon points="271.11 .66 382.36 .44 343.82 55.92 379.73 55.92 379.73 93.06 268.04 93.06 310.97 37.14 271.11 37.14 271.11 .66" />
      <polygon points="162.05 56.8 211.11 56.8 211.11 93.06 110.37 93.06 110.37 0 161.4 0 162.05 .66 162.05 56.8" />
      <rect x="215.05" width="51.68" height="93.06" />
    </svg>
  );
}
*/
