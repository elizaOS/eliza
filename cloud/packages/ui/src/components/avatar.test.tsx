import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, AvatarFallback } from "./avatar";

describe("Avatar", () => {
  it("renders fallback when image is missing", () => {
    render(
      <Avatar>
        <AvatarFallback>CN</AvatarFallback>
      </Avatar>,
    );
    expect(screen.getByText("CN")).toBeInTheDocument();
  });
});
