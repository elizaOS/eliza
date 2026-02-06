#![allow(missing_docs)]
//! Scratchpad Actions module.

pub mod append;
pub mod delete;
pub mod list;
pub mod read;
pub mod search;
pub mod write;

pub use append::ScratchpadAppendAction;
pub use delete::ScratchpadDeleteAction;
pub use list::ScratchpadListAction;
pub use read::ScratchpadReadAction;
pub use search::ScratchpadSearchAction;
pub use write::ScratchpadWriteAction;
