pub mod change_directory;
pub mod edit_file;
pub mod execute_shell;
pub mod git;
pub mod list_files;
pub mod read_file;
pub mod search_files;
pub mod write_file;

pub use change_directory::ChangeDirectoryAction;
pub use edit_file::EditFileAction;
pub use execute_shell::ExecuteShellAction;
pub use git::GitAction;
pub use list_files::ListFilesAction;
pub use read_file::ReadFileAction;
pub use search_files::SearchFilesAction;
pub use write_file::WriteFileAction;

pub fn get_code_actions() -> Vec<Box<dyn crate::Action>> {
    vec![
        Box::new(ReadFileAction),
        Box::new(WriteFileAction),
        Box::new(EditFileAction),
        Box::new(ListFilesAction),
        Box::new(SearchFilesAction),
        Box::new(ChangeDirectoryAction),
        Box::new(ExecuteShellAction),
        Box::new(GitAction),
    ]
}
