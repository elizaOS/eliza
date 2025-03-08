import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Agent } from "@elizaos/core";
import { Check, Eye, EyeOff, MoreVertical, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type EnvVariable = {
	name: string;
	value: string;
};

interface SecretPanelProps {
	characterValue: Agent;
	setCharacterValue: (value: (prev: Agent) => Agent) => void;
}

export default function EnvSettingsPanel({
	characterValue,
	setCharacterValue,
}: SecretPanelProps) {
	const [envs, setEnvs] = useState<EnvVariable[]>(
		Object.entries(characterValue?.settings?.secrets || {}).map(
			([name, value]) => ({
				name,
				value: String(value),
			}),
		),
	);

	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [editedValue, setEditedValue] = useState("");

	const dropdownRef = useRef<HTMLDivElement>(null);

	const addEnv = () => {
		if (name && value) {
			setEnvs([...envs, { name, value }]);
			setName("");
			setValue("");
		}
	};

	const startEditing = (index: number) => {
		setEditingIndex(index);
		setEditedValue(envs[index].value);
		setOpenIndex(null);
	};

	const saveEdit = (index: number) => {
		const updatedEnvs = [...envs];
		updatedEnvs[index].value = editedValue;
		setEnvs(updatedEnvs);
		setEditingIndex(null);
	};

	const removeEnv = (index: number) => {
		setEnvs(envs.filter((_, i) => i !== index));
		setOpenIndex(null);
		setEditingIndex(null);
	};

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(event.target as Node)
			) {
				setOpenIndex(null);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, []);

	useEffect(() => {
		setCharacterValue((prev) => ({
			...prev,
			settings: {
				...prev.settings,
				secrets: Object.fromEntries(
					envs.map(({ name, value }) => [name, value]),
				),
			},
		}));
	}, [envs, setCharacterValue]);

	return (
		<div className="rounded-lg w-full">
			<h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>

			<div className="grid grid-cols-[1fr_2fr_auto] gap-4 items-end w-full pb-4">
				<div className="flex flex-col gap-1">
					<label
						htmlFor="secret-name"
						className="ml-2 text-xs font-medium text-gray-400"
					>
						NAME
					</label>
					<Input
						id="secret-name"
						placeholder="VARIABLE_NAME"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1 relative">
					<label
						htmlFor="secret-value"
						className="ml-2 text-xs font-medium text-gray-400"
					>
						VALUE
					</label>
					<div className="relative">
						<Input
							id="secret-value"
							type={showPassword ? "text" : "password"}
							placeholder="i9ju23nfsdf56"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							className="pr-10"
						/>
						<div
							className="absolute inset-y-0 right-3 flex items-center cursor-pointer text-gray-500"
							onClick={() => setShowPassword(!showPassword)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									setShowPassword(!showPassword);
								}
							}}
						>
							{showPassword ? <EyeOff /> : <Eye />}
						</div>
					</div>
				</div>
				<Button className="shrink-0" onClick={addEnv}>
					Add
				</Button>
			</div>

			{envs.length > 0 && (
				<div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
					<div>Name</div>
					<div>Value</div>
					<div>Action</div>
				</div>
			)}

			<div className="mt-2">
				{envs.map((env, index) => (
					<div
						key={index}
						className="grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-2 ml-1 relative"
					>
						<div>{env.name}</div>
						<div>
							{editingIndex === index ? (
								<div className="flex items-center gap-2">
									<Input
										value={editedValue}
										onChange={(e) => setEditedValue(e.target.value)}
										className="w-full"
									/>
									<Button variant="ghost" onClick={() => saveEdit(index)}>
										<Check className="w-5 h-5 text-green-500" />
									</Button>
									<Button variant="ghost" onClick={() => setEditingIndex(null)}>
										<X className="w-5 h-5 text-red-500" />
									</Button>
								</div>
							) : (
								<div className="truncate text-gray-500">Encrypted</div>
							)}
						</div>
						<div className="relative">
							<Button
								variant="ghost"
								className="p-2 text-gray-500"
								onClick={() => setOpenIndex(openIndex === index ? null : index)}
							>
								<MoreVertical className="w-5 h-5" />
							</Button>
							{openIndex === index && (
								<div
									className="absolute right-0 -top-2 mt-2 w-24 bg-muted border rounded shadow-md z-10"
									ref={dropdownRef}
								>
									<div
										className="w-full px-4 py-2 text-left hover:opacity-50 cursor-pointer"
										onClick={() => startEditing(index)}
									>
										Edit
									</div>
									<div
										className="w-full px-4 py-2 text-left text-red-500 hover:opacity-50 cursor-pointer"
										onClick={() => removeEnv(index)}
									>
										Remove
									</div>
								</div>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
