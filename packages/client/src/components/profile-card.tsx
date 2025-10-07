import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';

interface ButtonConfig {
  label?: string;
  icon?: React.ReactNode;
  action?: () => void;
  className?: string;
  variant?:
    | 'link'
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | null
    | undefined;
  size?: 'default' | 'sm' | 'lg' | 'icon' | null | undefined;
  disabled?: boolean;
}

interface ProfileCardProps {
  title: React.ReactNode;
  content: React.ReactNode;
  buttons: ButtonConfig[];
  className?: string;
}

export default function ProfileCard({ title, content, buttons, className }: ProfileCardProps) {
  return (
    <Card className={`h-full ${className || ''}`}>
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-base truncate max-w-48">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-3">
        <div
          className="rounded-md bg-muted w-full mb-3 overflow-hidden"
          style={{ aspectRatio: '1 / 1' }}
        >
          <div className="flex items-center justify-center h-full">
            <div className="text-4xl font-bold uppercase h-full flex items-center justify-center w-full">
              {content}
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter className="p-3 pb-4">
        <div className="flex items-center gap-2 w-full justify-center">
          {buttons.map(({ label, icon, action, className, variant, size, disabled }, index) => (
            <Button
              key={index}
              variant={variant}
              className={className}
              onClick={action}
              size={size}
              disabled={disabled}
            >
              {icon}
              {label && <span>{label}</span>}
            </Button>
          ))}
        </div>
      </CardFooter>
    </Card>
  );
}
