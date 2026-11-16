import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { CardFooter, type CardProps, CardTitle } from "./Card.tsx";
import { Progress } from "./Progress.tsx";

export const meta: ComponentMeta<CardProps> = {
  args: {
    children: (
      <>
        <CardTitle>Order 1042</CardTitle>
        <Progress value={2} max={3} aria-label="Shipped" />
        <CardFooter>
          <Button>Track</Button>
        </CardFooter>
      </>
    ),
  },
};
