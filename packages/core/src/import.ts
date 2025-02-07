const registrations = new Map<string, any>();

export const dynamicImport = async (specifier: string) => {
  const module = registrations.get(specifier);
  if (module !== undefined) {
    return module;
  } else {
    return await import(specifier);
  }
};

export const registerDynamicImport = (specifier: string, module: any) => {
  registrations.set(specifier, module);
};