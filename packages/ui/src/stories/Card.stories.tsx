import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

const meta: Meta<typeof Card> = { title: "Molecules/Card", component: Card };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Agent Alpha</CardTitle>
          <Badge variant="secondary">Online</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-muted">Messages</span>
            <p className="font-semibold text-sm">1,247</p>
          </div>
          <div>
            <span className="text-muted">Uptime</span>
            <p className="font-semibold text-sm">99.8%</p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button variant="outline" size="sm">
          Config
        </Button>
        <Button size="sm">Launch</Button>
      </CardFooter>
    </Card>
  ),
};
