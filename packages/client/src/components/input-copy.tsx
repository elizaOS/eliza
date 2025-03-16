import { Input } from './ui/input';
import { Label } from './ui/label';

export default function InputCopy({
  title,
  name,
  value,
  onChange,
}: {
  title: string;
  name: string;
  value: string | number | undefined;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      <Input name={name} value={value} onChange={onChange} />
    </div>
  );
}
