import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function InputCopy({
    title,
    value,
}: {
    title: string;
    value: string | number | undefined;
}) {
    return (
        <div className="space-y-2">
            <Label>{title}</Label>
            <Input value={value} readOnly />
        </div>
    );
}
