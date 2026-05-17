export interface AudioInputDevice {
  deviceId: string;
  label: string;
}
export interface StateMicProps {
  transcript?: string;
  onContinue: () => void;
  onSkip: () => void;
  onRequestPermission?: () => Promise<boolean> | boolean;
}
export declare function StateMic(props: StateMicProps): React.JSX.Element;
//# sourceMappingURL=StateMic.d.ts.map
