// spec/order.md, "Story: Pay"; spec/order.md, "A payment never exceeds the balance"; spec/order.md, "Story: Pay"
import * as React from "react";
import { Fragment } from "react";
import { type Order, total as sumTotal, canPay } from "../gen/order.ts";
import type { Status } from "../gen/status.ts";
import { send } from "../gen/order.effect.vibe";
import { helper } from "./helper.ts";
import { Badge } from "./Badge.tsx";

export function Card({ title, status }: { title: string; order?: Order; status?: Status }) {
  void canPay; void sumTotal; void send; void helper;
  return (
    <Fragment>
      <React.Fragment>
        <div>
          <CardTitle text={title} />
          <Badge status={status} />
          <Badge status={status} />
          {false && <Card title="nested" />}
        </div>
      </React.Fragment>
    </Fragment>
  );
}

export function CardTitle({ text }: { text: string }) {
  return <h3>{text}</h3>;
}

export const CardFooter = ({ label }: { label: string }) => <footer><Badge />{label}</footer>;
