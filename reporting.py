from collections import defaultdict

class Report:
    def __init__(self):
        self.data = defaultdict(list)

    def add_entry(self, category, entry):
        self.data[category].append(entry)

    def generate_report(self):
        for category, entries in self.data.items():
            print(f'Category: {category}')
            for entry in entries:
                print(f' - {entry}')

# Usage example
report = Report()
report.add_entry('Error', 'Failed to load resource')
report.add_entry('Warning', 'Deprecated API usage')
report.generate_report()
