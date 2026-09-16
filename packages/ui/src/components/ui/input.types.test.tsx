/** Compile-time contracts for native input types and their presentations. */
import { describe, expect, it } from "vitest";
import { Input, type InputProps } from "./input";

function NativeInputTypeContract() {
  return (
    <>
      <Input type="file" variant="nativeFileHidden" />
      <Input type="file" variant="nativeFileDisplayNone" />
      <Input type="range" variant="nativeRange" />
      <Input type="color" variant="nativeColor" />

      {/* @ts-expect-error nativeRange is only valid for range inputs. */}
      <Input type="color" variant="nativeRange" />
      {/* @ts-expect-error nativeColor is only valid for color inputs. */}
      <Input type="text" variant="nativeColor" />
      {/* @ts-expect-error native file presentations are only valid for file inputs. */}
      <Input type="range" variant="nativeFileHidden" />
    </>
  );
}

describe("InputProps native presentation contract", () => {
  it("retains the standard HTML input type contract", () => {
    const props: InputProps = { type: "email", variant: "form" };
    expect(props).toEqual({ type: "email", variant: "form" });
    expect(NativeInputTypeContract).toBeTypeOf("function");
  });
});
