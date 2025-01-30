import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function ArrayInput({
    title,
    data,
}: {
    title: string;
    data: string[];
}) {
    return (
        <div className="space-y-2">
            <Label>{title}</Label>
            <div className="p-2 bg-card rounded-md border">
                <div className="space-y-2">
                    {data?.map((b: string, _idx: number) => (
                        <Input value={b} key={b} className="bg-background" />
                    ))}
                </div>
            </div>
        </div>
    );
}
