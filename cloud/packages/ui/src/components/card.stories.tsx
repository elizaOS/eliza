import type { Meta } from "@storybook/react";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
  tags: ["autodocs"],
};

export default meta;

export const Default = () => (
  <Card className="w-[350px]">
    <CardHeader>
      <CardTitle>Create project</CardTitle>
      <CardDescription>Deploy your new project in one-click.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col space-y-1.5">
        <span className="text-sm font-medium">Name</span>
        <div className="h-10 px-3 py-2 border border-white/10 rounded-md bg-black/40">
          Next.js Project
        </div>
      </div>
    </CardContent>
    <CardFooter className="flex justify-between">
      <Button variant="outline">Cancel</Button>
      <Button>Deploy</Button>
    </CardFooter>
  </Card>
);
