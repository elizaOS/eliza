/** Shared config-form control primitive: the stacked list of field validation errors, rendered by both `ConfigRenderer` and `UiRenderer`. */
export function ConfigFieldErrors({
  errors,
}: {
  errors?: readonly string[] | undefined;
}) {
  if (!errors?.length) {
    return null;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {errors.map((err) => (
        <span key={err} className="text-2xs text-destructive">
          {err}
        </span>
      ))}
    </div>
  );
}
