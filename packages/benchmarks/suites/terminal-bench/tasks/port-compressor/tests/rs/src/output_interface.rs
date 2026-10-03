pub trait OutputInterface {
    fn write(&mut self, data: &[u8]) -> bool;
}
