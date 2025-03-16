import type { UUID } from "@elizaos/core";
import { Database, LoaderIcon, MailIcon, Trash2, Pencil, Book, Upload, FileText, X, Clock, File } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAgentMemories, useDeleteMemory } from "../hooks/use-query-hooks";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

import type { Memory } from "@elizaos/core";
import MemoryEditOverlay from "./memory-edit-overlay";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "./ui/dialog";
import { cn } from "@/lib/utils";

// Number of items to load per batch
const ITEMS_PER_PAGE = 10;

export function AgentMemoryViewer({ agentId }: { agentId: UUID }) {
	const [selectedType, setSelectedType] = useState<string>("knowledge");
	const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
	const [viewingContent, setViewingContent] = useState<Memory | null>(null);
	const [isUploading, setIsUploading] = useState(false);
	const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
	const [loadingMore, setLoadingMore] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const { toast } = useToast();
	const queryClient = useQueryClient();
	
	// Determine if we need to use the 'documents' table for knowledge
	const tableName = selectedType === "knowledge" 
		? "documents" 
		: selectedType === "thought" || selectedType === "message" || selectedType === "all"
			? "messages"
			: undefined;
	
	const { data: memories = [], isLoading, error } = useAgentMemories(agentId, tableName);
	const { mutate: deleteMemory } = useDeleteMemory();
	
	// Handle scroll to implement infinite loading
	const handleScroll = useCallback(() => {
		if (!scrollContainerRef.current || loadingMore || visibleItems >= filteredMemories.length) {
			return;
		}

		const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
		const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 100; // 100px buffer
		
		if (scrolledToBottom) {
			setLoadingMore(true);
			// Add a small delay to simulate loading and prevent too rapid updates
			setTimeout(() => {
				setVisibleItems(prev => Math.min(prev + ITEMS_PER_PAGE, filteredMemories.length));
				setLoadingMore(false);
			}, 300);
		}
	}, [loadingMore, visibleItems]);

	// Reset visible items when filter changes or new data loads
	useEffect(() => {
		setVisibleItems(ITEMS_PER_PAGE);
	}, [selectedType, memories.length]);

	// Set up scroll event listener
	useEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (scrollContainer) {
			scrollContainer.addEventListener('scroll', handleScroll);
			return () => scrollContainer.removeEventListener('scroll', handleScroll);
		}
	}, [handleScroll]);
	
	if (isLoading && (!memories || memories.length === 0)) {
		return <div className="flex items-center justify-center h-40">Loading memories...</div>;
	}
	
	if (error) {
		return (
			<div className="flex items-center justify-center h-40 text-destructive">
				Error loading agent memories
			</div>
		);
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
	};

	const getMemoryIcon = (memoryType: string | undefined, content: any) => {
		if (selectedType === "knowledge") return <Book className="w-4 h-4" />;
		if (content?.thought) return <LoaderIcon className="w-4 h-4" />;
		if (!content?.thought) return <MailIcon className="w-4 h-4" />;
		return <Database className="w-4 h-4" />;
	};

	const getMemoryLabel = (memoryType: string | undefined, content: any) => {
		if (selectedType === "knowledge") return "Knowledge";
		if (content?.thought) return "Thought";
		if (!content?.thought) return "Message";
		return memoryType || "Memory";
	};

	const getFileIcon = (fileName: string) => {
		const ext = fileName.split('.').pop()?.toLowerCase();
		
		switch(ext) {
			case 'md':
				return <File className="h-4 w-4 text-blue-500" />;
			case 'js':
			case 'ts':
			case 'jsx':
			case 'tsx':
				return <File className="h-4 w-4 text-yellow-500" />;
			case 'json':
				return <File className="h-4 w-4 text-green-500" />;
			case 'txt':
			default:
				return <FileText className="h-4 w-4 text-gray-500" />;
		}
	};

	// Extract a more meaningful title from the content
	const getDocumentTitle = (content: any) => {
		const metadata = content?.metadata || {};
		let filename = metadata.filename || "Unknown Document";
		
		// Try to extract a title from the first lines of the file content
		if (content?.text) {
			// First try to get the filename from "Path:" line
			const pathMatch = content.text.match(/Path: ([^\n]+)/);
			if (pathMatch?.[1]) {
				filename = pathMatch[1].split('/').pop() || filename;
			}
			
			// Then try to find a heading that might serve as a title
			const textLines = content.text.split('\n');
			for (let i = 0; i < Math.min(20, textLines.length); i++) {
				const line: string = textLines[i].trim();
				// Match markdown headings or lines that look like titles (capitalized, not too long)
				if (line.startsWith('# ')) {
					return line.replace(/^# /, '');
				}
				
				// Look for title: pattern
				if (line.toLowerCase().startsWith('title:')) {
					return line.replace(/^title:\s*/i, '').trim();
				}
				
				// Look for Survey Note: pattern
				if (line.includes('Survey Note:')) {
					return line.replace('Survey Note:', '').trim();
				}
				
				// Look for all-caps lines or lines with mostly capitalized words
				if (line.length > 0 && line.length < 60 && (/^[A-Z][A-Za-z\s]+$/.test(line) || line === line.toUpperCase())) {
					return line;
				}
			}
		}
		
		return filename;
	};
	
	// Extract a description from content
	const getDocumentDescription = (content: any) => {
		if (!content?.text) return null;
		
		const textLines = content.text.split('\n');
		let description = '';
		let inDescription = false;
		let skipLines = 0;
		
		// Skip Path: line and empty lines at the beginning
		for (let i = 0; i < textLines.length; i++) {
			if (textLines[i].startsWith('Path:')) {
				skipLines = i + 1;
				break;
			}
		}
		
		// Skip title and empty lines
		for (let i = skipLines; i < Math.min(skipLines + 15, textLines.length); i++) {
			const line = textLines[i].trim();
			
			// Skip empty lines at the beginning
			if (!inDescription && line === '') continue;
			
			// Skip the title (assuming the first non-empty line after Path: could be a title)
			if (!inDescription && line.startsWith('#')) {
				inDescription = true;
				continue;
			}
			
			// Skip "description:" prefix
			if (line.toLowerCase().startsWith('description:')) {
				description = line.replace(/^description:\s*/i, '').trim();
				inDescription = true;
				continue;
			}
			
			// If we've found content, mark as in description
			if (line !== '') {
				inDescription = true;
			}
			
			// Start collecting description text
			if (inDescription) {
				// Don't add markdown headers to description
				if (line.startsWith('#')) continue;
				
				if (description && line) {
					description += ' ' + line;
				} else if (line) {
					description = line;
				}
				
				// Get about 150 chars of description
				if (description.length > 150) {
					break;
				}
			}
		}
		
		return description ? description.trim().substring(0, 150) + (description.length > 150 ? '...' : '') : null;
	};

	const handleDelete = (memoryId: string) => {
		if (memoryId && window.confirm("Are you sure you want to delete this memory entry?")) {
			deleteMemory({ agentId, memoryId });
			setViewingContent(null); // Close detail view if open
		}
	};

	const handleUploadClick = () => {
		if (fileInputRef.current) {
			fileInputRef.current.click();
		}
	};

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;

		setIsUploading(true);
		
		try {
			const fileArray = Array.from(files);
			const result = await apiClient.uploadKnowledge(agentId, fileArray);
			
			if (result.success) {
				toast({
					title: "Knowledge Uploaded",
					description: `Successfully uploaded ${fileArray.length} file(s)`,
				});
				
				// Invalidate queries to refresh the memory list
				queryClient.invalidateQueries({
					queryKey: ['agents', agentId, 'memories', 'documents']
				});
			}
		} catch (error) {
			toast({
				title: "Upload Failed",
				description: error instanceof Error ? error.message : "Failed to upload knowledge files",
				variant: "destructive",
			});
		} finally {
			setIsUploading(false);
			// Reset file input
			if (fileInputRef.current) {
				fileInputRef.current.value = '';
			}
		}
	};

	const filteredMemories = memories.filter((memory: Memory) => {
		if (selectedType === "all") return true;
		if (selectedType === "knowledge") return true; // Already filtered by tableName
		
		const content = memory.content as any;
		// Check for thought messages based on channelType or actual thought property
		if (selectedType === "thought") {
			return content?.thought === true || 
			       content?.channelType === "thought" || 
			       memory.metadata?.type === "thought";
		}
		// Messages are anything that's not a thought
		if (selectedType === "message") {
			return !(content?.thought === true ||
			        content?.channelType === "thought" ||
			        memory.metadata?.type === "thought");
		}
		return true;
	});

	// Get visible subset for infinite scrolling
	const visibleMemories = filteredMemories.slice(0, visibleItems);
	const hasMoreToLoad = visibleItems < filteredMemories.length;

	return (
		<div className="flex flex-col h-[calc(100vh-200px)] min-h-[400px] w-full">
			<div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none">
				<div className="flex items-center gap-2">
					<h3 className="text-lg font-medium">
						{selectedType === "knowledge" ? "Knowledge Library" : "Agent Memories"}
					</h3>
					{selectedType === "knowledge" && (
						<Button 
							variant="ghost" 
							size="icon"
							onClick={handleUploadClick}
							disabled={isUploading}
							className="rounded-full"
							title="Upload documents"
						>
							<Upload className="h-4 w-4" />
							<span className="sr-only">
								{isUploading ? 'Uploading...' : 'Upload Documents'}
							</span>
						</Button>
					)}
					<input
						type="file"
						ref={fileInputRef}
						onChange={handleFileChange}
						className="hidden"
						multiple
						accept=".txt,.md,.js,.ts,.jsx,.tsx,.json,.csv,.html,.css"
					/>
				</div>
				<Select value={selectedType} onValueChange={setSelectedType}>
					<SelectTrigger className="w-32">
						<SelectValue placeholder="Filter memories" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All</SelectItem>
						<SelectItem value="thought">Thoughts</SelectItem>
						<SelectItem value="message">Messages</SelectItem>
						<SelectItem value="knowledge">Knowledge</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div 
				ref={scrollContainerRef}
				className="flex-1 overflow-y-auto px-4 pb-4" 
				style={{ height: "calc(100% - 60px)" }}
			>
				{filteredMemories.length === 0 ? (
					<div className="text-muted-foreground text-center p-8 flex flex-col items-center gap-2">
						{selectedType === "knowledge" ? (
							<>
								<Book className="h-12 w-12 opacity-20" />
								<p>No knowledge documents yet</p>
								<Button 
									variant="outline" 
									className="mt-2"
									onClick={handleUploadClick}
								>
									<Upload className="h-4 w-4 mr-2" />
									Upload Documents
								</Button>
							</>
						) : (
							<>No memories recorded yet</>
						)}
					</div>
				) : (
					<div className="space-y-4">
						{/* For knowledge files display - Single column layout */}
						{selectedType === "knowledge" && (
							<div className="flex flex-col gap-4 max-w-3xl mx-auto">
								{visibleMemories.map((memory: Memory, index: number) => {
									const content = memory.content as any;
									const metadata = content?.metadata || {};
									const title = getDocumentTitle(content);
									const description = getDocumentDescription(content);
									const filename = metadata.filename || "Unknown Document";
									const fileExt = filename.split('.').pop()?.toLowerCase() || '';
									
									// Get a preview if description not available
									let preview = description;
									if (!preview && content?.text) {
										const textLines = content.text.split('\n');
										const pathLineIndex = textLines.findIndex((line: string) => line.startsWith('Path:'));
										
										if (pathLineIndex !== -1) {
											const contentStart = pathLineIndex + 1;
											// Skip empty lines after Path:
											let startLine = contentStart;
											while (startLine < textLines.length && textLines[startLine].trim() === '') {
												startLine++;
											}
											
											const previewText = textLines.slice(startLine).join('\n').trim();
											preview = previewText.length > 0 ? 
												`${previewText.substring(0, 150)}${previewText.length > 150 ? '...' : ''}` : 
												'No preview available';
										}
									}
									
									return (
										<div 
											key={memory.id || index} 
											className="border rounded-md bg-card hover:bg-accent/10 transition-colors relative group cursor-pointer flex flex-col"
											onClick={() => setViewingContent(memory)}
										>
											{/* Icon and document type */}
											<div className="absolute top-3 left-3 opacity-70">
												{getFileIcon(filename)}
											</div>
											
											{/* Content area with indentation for icon */}
											<div className="p-3 flex-1 pl-10">
												{/* Path/filename as a small badge */}
												<div className="text-xs text-muted-foreground mb-1 line-clamp-1">
													{filename}
												</div>
												
												{/* Title and description section */}
												<div className="mb-2">
													<div className="text-sm font-medium mb-1">{title}</div>
													{description && (
														<div className="text-xs text-muted-foreground line-clamp-2">
															description: "{description}"
														</div>
													)}
												</div>
												
												{/* First header or content as preview */}
												<div className="text-xs mt-3 text-foreground/80 line-clamp-2">
													{preview && !description ? preview : null}
												</div>
											</div>
											
											{/* Timestamp and actions footer */}
											<div className="flex justify-between items-center p-2 border-t bg-muted/30 text-xs text-muted-foreground">
												<div className="flex items-center">
													<Clock className="h-3 w-3 mr-1.5" />
													<span>
														{new Date(memory.createdAt || 0).toLocaleString(undefined, {
															month: 'numeric', 
															day: 'numeric', 
															year: 'numeric',
															hour: 'numeric',
															minute: 'numeric',
														})}
													</span>
												</div>
												
												<div className="flex items-center gap-2">
													<Badge 
														variant="outline" 
														className="px-1.5 py-0 h-5"
													>
														{fileExt || 'unknown document'}
													</Badge>
													
													{memory.id && (
														<Button
															variant="ghost"
															size="icon"
															className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
															onClick={(e) => {
																e.stopPropagation();
																e.preventDefault();
																handleDelete(memory.id || '');
															}}
															title="Delete knowledge"
														>
															<Trash2 className="h-3.5 w-3.5 text-destructive" />
														</Button>
													)}
												</div>
											</div>
										</div>
									);
								})}

								{/* Loading indicator for infinite scroll */}
								{hasMoreToLoad && (
									<div className="flex justify-center p-4">
										{loadingMore ? (
											<div className="flex items-center gap-2">
												<LoaderIcon className="h-4 w-4 animate-spin" />
												<span className="text-sm text-muted-foreground">Loading more...</span>
											</div>
										) : (
											<Button 
												variant="ghost" 
												size="sm" 
												onClick={() => setVisibleItems(prev => prev + ITEMS_PER_PAGE)}
												className="text-xs"
											>
												Show more
											</Button>
										)}
									</div>
								)}
							</div>
						)}
						
						{/* For non-knowledge memories - keep existing layout */}
						{selectedType !== "knowledge" && (
							<div className="space-y-3">
								{visibleMemories.map((memory: Memory, index: number) => {
									const memoryType = memory.metadata?.type || "Memory";
									const content = memory.content as any;
									const source = content?.source;
									
									return (
										<div 
											key={memory.id || index} 
											className="border rounded-md p-3 bg-card hover:bg-accent/10 transition-colors relative group"
										>
											{memory.id && (
												<div className="absolute top-2 right-2 flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
													<Button
														variant="secondary"
														size="icon"
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															setEditingMemory(memory);
														}}
														title="Edit memory"
													>
														<Pencil className="h-4 w-4 text-regular" />
													</Button>
													<Button
														variant="secondary"
														size="icon"
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															handleDelete(memory.id || '');
														}}
														title="Delete memory"
													>
														<Trash2 className="h-4 w-4 text-destructive" />
													</Button>
												</div>
											)}
											
											<div className="flex items-center justify-between">
												<span className="text-sm font-medium flex items-center gap-1">
													{getMemoryIcon(memoryType, content)} {getMemoryLabel(memoryType, content)}
												</span>
												<div className="flex items-center gap-2">
													{source && (
														<Badge variant="secondary" className="text-xs">
															{source}
														</Badge>
													)}
													<Badge variant="outline" className="text-xs group-hover:mr-8 transition-all">
														{formatDate(memory.createdAt || 0)}
													</Badge>
												</div>
											</div>
											
											<div className="mt-2 grid gap-2 rounded-full">
												{memory.id && (
													<div className="text-xs bg-muted px-2 py-1 rounded">
														<span className="font-semibold">ID: </span>
														{memory.id}
													</div>
												)}
												
												{memory.content && (
													<div className="text-xs bg-muted px-2 py-1 rounded max-h-40 overflow-y-auto">
														<span className="font-semibold">Content: </span>
														{typeof memory.content === 'object' 
															? JSON.stringify(memory.content, null, 2)
															: memory.content}
													</div>
												)}
												
												{memory.metadata && Object.keys(memory.metadata).length > 0 && (
													<div className="text-xs bg-muted px-2 py-1 rounded max-h-32 overflow-y-auto">
														<span className="font-semibold">Metadata: </span>
														{typeof memory.metadata === 'object' 
															? JSON.stringify(memory.metadata, null, 2)
															: memory.metadata}
													</div>
												)}
											</div>
										</div>
									);
								})}

								{/* Loading indicator for non-knowledge memories */}
								{hasMoreToLoad && (
									<div className="flex justify-center p-4">
										{loadingMore ? (
											<div className="flex items-center gap-2">
												<LoaderIcon className="h-4 w-4 animate-spin" />
												<span className="text-sm text-muted-foreground">Loading more...</span>
											</div>
										) : (
											<Button 
												variant="ghost" 
												size="sm" 
												onClick={() => setVisibleItems(prev => prev + ITEMS_PER_PAGE)}
												className="text-xs"
											>
												Show more
											</Button>
										)}
									</div>
								)}
							</div>
						)}
					</div>
				)}
			</div>

			{/* Knowledge content dialog */}
			<Dialog open={!!viewingContent} onOpenChange={(open) => !open && setViewingContent(null)}>
				<DialogContent className="max-w-4xl h-[80vh] flex flex-col">
					<DialogHeader className="border-b pb-3">
						<DialogTitle className="flex items-center">
							{(() => {
								const content = viewingContent?.content as any;
								const metadata = content?.metadata || {};
								const filename = metadata.filename || "Unknown Document";
								
								return (
									<>
										{getFileIcon(filename)}
										<span className="ml-2">{getDocumentTitle(content)}</span>
									</>
								);
							})()}
						</DialogTitle>
						<DialogDescription className="flex items-center mt-1">
							<Clock className="h-3.5 w-3.5 mr-1" />
							Added on {viewingContent ? formatDate(viewingContent.createdAt || 0) : ''}
						</DialogDescription>
					</DialogHeader>

					<div className="flex-1 overflow-y-auto my-4 border rounded-md p-4 bg-muted">
						{viewingContent && (
							<pre className={cn("text-sm whitespace-pre-wrap", {
								"font-mono": ((viewingContent.content as any)?.metadata?.fileType as string)?.includes("application/") || 
											 ((viewingContent.content as any)?.metadata?.fileType as string)?.includes("text/plain"),
								"": !((viewingContent.content as any)?.metadata?.fileType as string)?.includes("application/") &&
									!((viewingContent.content as any)?.metadata?.fileType as string)?.includes("text/plain")
							})}>
								{viewingContent.content?.text}
							</pre>
						)}
					</div>

					<DialogFooter>
						<Button 
							variant="destructive"
							onClick={() => viewingContent?.id && handleDelete(viewingContent.id)}
							className="mr-auto"
						>
							<Trash2 className="h-4 w-4 mr-2" />
							Delete
						</Button>
						
						<Button onClick={() => setViewingContent(null)}>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			
			{editingMemory && (
				<MemoryEditOverlay
					isOpen={!!editingMemory}
					onClose={() => setEditingMemory(null)}
					memory={editingMemory}
					agentId={agentId}
				/>
			)}
		</div>
	);
}
