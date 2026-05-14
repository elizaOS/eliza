declare module "react-test-renderer" {
	export function act<T>(callback: () => T | Promise<T>): Promise<Awaited<T>>;
}
