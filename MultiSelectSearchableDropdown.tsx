import * as React from 'react';
import OutlinedInput from '@mui/material/OutlinedInput';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import ListItemText from '@mui/material/ListItemText';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import Checkbox from '@mui/material/Checkbox';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';

interface ContractWorkspace {
  id: string;
  label: string;
}

interface Props {
  options: ContractWorkspace[];
  selectedValues: string[];
  onSelect: (selected: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  selectionLimit?: number;

  // New props for server-side searching
  onSearchRequest?: (term: string) => Promise<ContractWorkspace[]>;
  debounceMs?: number; // default 350ms
}

const ITEM_HEIGHT = 48;
const ITEM_PADDING_TOP = 8;
const MenuProps = {
  PaperProps: {
    style: {
      maxHeight: ITEM_HEIGHT * 4.5 + ITEM_PADDING_TOP,
      width: 250,
    },
  },
  anchorOrigin: {
    vertical: 'bottom' as const,
    horizontal: 'left' as const,
  },
  transformOrigin: {
    vertical: 'top' as const,
    horizontal: 'left' as const,
  },
  keepMounted: true,
  autoFocus: false,
  variant: 'menu' as const,
};

export const MultiSelectSearchableDropdown: React.FC<Props> = ({
  options,
  selectedValues,
  onSelect,
  placeholder = "Select options",
  disabled = false,
  selectionLimit = 0,
  onSearchRequest,
  debounceMs = 350,
}) => {
  const [searchTerm, setSearchTerm] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  // NEW: local display list and searching state
  const [displayedOptions, setDisplayedOptions] = React.useState<ContractWorkspace[]>(options || []);
  const [searching, setSearching] = React.useState<boolean>(false);
  const lastReqId = React.useRef<number>(0);

  // Keep displayedOptions in sync when options prop changes (e.g., initial load)
  React.useEffect(() => {
    if (!open) {
      setDisplayedOptions(options || []);
    }
  }, [options, open]);

  // Validate props
  React.useEffect(() => {
    if (selectionLimit < 0) {
      console.warn('selectionLimit should be 0 or positive number');
    }
  }, [selectionLimit]);

  // Reset search when dropdown closes
  React.useEffect(() => {
    if (!open) {
      setSearchTerm('');
      setSearching(false);
    }
  }, [open]);

  // Focus search input when dropdown opens
  React.useEffect(() => {
    if (open && searchInputRef.current) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Initial fetch on open (server-side mode)
  React.useEffect(() => {
    const fetchInitial = async () => {
      if (open && onSearchRequest) {
        setSearching(true);
        const reqId = ++lastReqId.current;
        try {
          const result = await onSearchRequest('');
          // Only apply the latest request
          if (reqId === lastReqId.current) {
            setDisplayedOptions(result || []);
          }
        } catch (e) {
          console.error('Dropdown initial search failed:', e);
          setDisplayedOptions([]);
        } finally {
          if (reqId === lastReqId.current) {
            setSearching(false);
          }
        }
      } else if (open) {
        // Client-side mode: show all options
        setDisplayedOptions(options || []);
      }
    };
    fetchInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Handle search changes: server or client
  React.useEffect(() => {
    // Debounced server-side search
    if (onSearchRequest) {
      const handler = setTimeout(async () => {
        setSearching(true);
        const reqId = ++lastReqId.current;
        try {
          const result = await onSearchRequest(searchTerm.trim());
          if (reqId === lastReqId.current) {
            setDisplayedOptions(result || []);
          }
        } catch (e) {
          console.error('Dropdown search failed:', e);
          if (reqId === lastReqId.current) {
            setDisplayedOptions([]);
          }
        } finally {
          if (reqId === lastReqId.current) {
            setSearching(false);
          }
        }
      }, debounceMs);
      return () => clearTimeout(handler);
    }

    // Client-side filtering
    const term = searchTerm.trim().toLowerCase();
    if (term.length === 0) {
      setDisplayedOptions(options || []);
    } else {
      setDisplayedOptions(
        (options || []).filter((opt) =>
          opt.label.toLowerCase().includes(term),
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, onSearchRequest, debounceMs]);

  const areAllFilteredSelected = React.useMemo(() => {
    if (displayedOptions.length === 0) return false;
    return displayedOptions.every(option => selectedValues.includes(option.id));
  }, [selectedValues, displayedOptions]);

  const areSomeFilteredSelected = React.useMemo(() => {
    if (displayedOptions.length === 0) return false;
    return displayedOptions.some(option => selectedValues.includes(option.id));
  }, [selectedValues, displayedOptions]);

  const canSelectMore = React.useMemo(() => {
    return selectionLimit === 0 || selectedValues.length < selectionLimit;
  }, [selectionLimit, selectedValues.length]);

  const availableSlots = React.useMemo(() => {
    if (selectionLimit === 0) return Infinity;
    return Math.max(0, selectionLimit - selectedValues.length);
  }, [selectionLimit, selectedValues.length]);

  // Handle MUI Select's onChange - suppress default behavior
  const handleSelectChange = (event: SelectChangeEvent<string[]>) => {
    // No-op: selection handled by MenuItem clicks
  };

  const handleItemClick = (optionId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const isCurrentlySelected = selectedValues.includes(optionId);
    let newSelected: string[];

    if (isCurrentlySelected) {
      newSelected = selectedValues.filter(id => id !== optionId);
    } else {
      if (!canSelectMore) {
        return;
      }
      newSelected = [...selectedValues, optionId];
    }

    onSelect(newSelected);
  };

  const handleSelectAll = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const filteredIds = displayedOptions.map(opt => opt.id);
    let newSelected: string[];

    if (areAllFilteredSelected) {
      const filteredIdsSet = new Set(filteredIds);
      newSelected = selectedValues.filter(id => !filteredIdsSet.has(id));
    } else {
      const currentSelectedSet = new Set(selectedValues);
      const toAdd = filteredIds.filter(id => !currentSelectedSet.has(id));

      if (selectionLimit > 0) {
        const canAdd = Math.min(toAdd.length, availableSlots);
        newSelected = [...selectedValues, ...toAdd.slice(0, canAdd)];
      } else {
        newSelected = [...selectedValues, ...toAdd];
      }
    }

    const menuList = document.querySelector('.MuiList-root') as HTMLElement;
    const menuPaper = document.querySelector('.MuiPaper-root') as HTMLElement;
    const currentScrollTop = menuList?.scrollTop || menuPaper?.scrollTop || 0;

    requestAnimationFrame(() => {
      onSelect(newSelected);
      requestAnimationFrame(() => {
        const updatedMenuList = document.querySelector('.MuiList-root') as HTMLElement;
        const updatedMenuPaper = document.querySelector('.MuiPaper-root') as HTMLElement;
        if (updatedMenuList) {
          updatedMenuList.scrollTop = currentScrollTop;
        } else if (updatedMenuPaper) {
          updatedMenuPaper.scrollTop = currentScrollTop;
        }
      });
    });
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    setSearchTerm(event.target.value);
  };

  const handleOpen = () => {
    if (!disabled) {
      setOpen(true);
    }
  };

  const handleClose = (event: React.SyntheticEvent) => {
    setOpen(false);
  };

  const getDisplayValue = (selected: string[]) => {
    if (selected.length === 0) return '';

    if (selected.length === options.length && options.length > 0) {
      return "All Selected";
    }

    const selectedLabels = selected
      .map(id => options.find(opt => opt.id === id)?.label)
      .filter((label): label is string => Boolean(label));

    if (selectedLabels.length === 0) return '';
    if (selectedLabels.length <= 2) return selectedLabels.join(', ');
    return `${selectedLabels.length} selected`;
  };

  const canSelectAllFiltered = React.useMemo(() => {
    if (areAllFilteredSelected) return true; // Can always deselect
    if (selectionLimit === 0) return true; // No limit

    const unselectedFiltered = displayedOptions.filter(opt => !selectedValues.includes(opt.id));
    return unselectedFiltered.length <= availableSlots;
  }, [areAllFilteredSelected, selectionLimit, displayedOptions, selectedValues, availableSlots]);

  return (
    <div>
      <FormControl fullWidth>
        <Select
          labelId="contract-workspace-label"
          id="contract-workspace-select"
          multiple
          open={open}
          onOpen={handleOpen}
          onClose={handleClose}
          value={selectedValues}
          onChange={handleSelectChange}
          input={<OutlinedInput notched={false} label="" />}
          disabled={disabled}
          displayEmpty
          renderValue={(selected) => {
            if (selected.length === 0) {
              return <em>{placeholder}</em>;
            }
            return getDisplayValue(selected as string[]);
          }}
          MenuProps={MenuProps}
        >
          {/* Search Box */}
          <Box
            className="search-container"
            component="div"
            sx={{ p: 1, borderBottom: '1px solid #ddd' }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <TextField
              inputRef={searchInputRef}
              placeholder="Search..."
              value={searchTerm}
              onChange={handleSearchChange}
              fullWidth
              variant="standard"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              InputProps={{
                disableUnderline: false,
              }}
            />
          </Box>

          {/* "Select All" option */}
          {displayedOptions.length > 0 && (
            <MenuItem
              onClick={handleSelectAll}
              disabled={!canSelectAllFiltered}
              sx={{
                borderBottom: '1px solid #ddd',
                ...(!canSelectAllFiltered && {
                  color: 'grey.500',
                })
              }}
            >
              <Checkbox
                checked={areAllFilteredSelected}
                indeterminate={areSomeFilteredSelected && !areAllFilteredSelected}
                disabled={!canSelectAllFiltered}
                tabIndex={-1}
              />
              <ListItemText
                primary="Select All"
                secondary={
                  searching
                    ? 'Searching...'
                    : (!canSelectAllFiltered && selectionLimit > 0 && !areAllFilteredSelected
                      ? `Only ${availableSlots} more selections allowed`
                      : (searchTerm.trim()
                        ? `${displayedOptions.length} filtered items`
                        : `${options.length} items`)
                    )
                }
              />
            </MenuItem>
          )}

          {/* Loading indicator */}
          {searching && (
            <MenuItem disabled>
              <ListItemText primary="Searching..." />
            </MenuItem>
          )}

          {/* Individual Options */}
          {!searching && displayedOptions.map((workspace) => {
            const isSelected = selectedValues.includes(workspace.id);
            const canSelectThis = isSelected || canSelectMore;

            return (
              <MenuItem
                key={workspace.id}
                value={workspace.id}
                onClick={(e) => handleItemClick(workspace.id, e)}
                disabled={!canSelectThis}
                sx={{
                  ...(!canSelectThis && {
                    color: 'grey.500',
                  })
                }}
              >
                <Checkbox
                  checked={isSelected}
                  disabled={!canSelectThis}
                  tabIndex={-1}
                />
                <ListItemText primary={workspace.label} />
              </MenuItem>
            );
          })}

          {/* No Results Message */}
          {!searching && displayedOptions.length === 0 && searchTerm.trim() && (
            <MenuItem disabled>
              <ListItemText
                primary="No results found"
                secondary={`No items match "${searchTerm.trim()}"`}
              />
            </MenuItem>
          )}

          {/* Empty State */}
          {!searching && options.length === 0 && searchTerm.trim().length === 0 && (
            <MenuItem disabled>
              <ListItemText primary="No options available" />
            </MenuItem>
          )}
        </Select>
      </FormControl>
    </div>
  );
};
