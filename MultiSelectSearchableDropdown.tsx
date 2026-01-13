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
import Divider from '@mui/material/Divider';

interface ContractWorkspace {
  id: string;
  label: string;
}

interface SearchResult {
  options: ContractWorkspace[];
  hasMore: boolean;
}

interface Props {
  selectedValues: string[];
  onSelect: (selected: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  selectionLimit?: number;

  // Server-side search + pagination
  onSearchRequest: (
    term: string,
    offset: number,
    limit: number
  ) => Promise<SearchResult>;

  debounceMs?: number;
  pageSize?: number; // default 100
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
  keepMounted: true,
};

export const MultiSelectSearchableDropdown: React.FC<Props> = ({
  selectedValues,
  onSelect,
  placeholder = "Select options",
  disabled = false,
  selectionLimit = 0,
  onSearchRequest,
  debounceMs = 350,
  pageSize = 100,
}) => {
  const [open, setOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [displayedOptions, setDisplayedOptions] = React.useState<
    ContractWorkspace[]
  >([]);
  const [searching, setSearching] = React.useState(false);

  // Pagination state
  const [offset, setOffset] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(true);

  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const lastReqId = React.useRef(0);

  /* ---------------------------------------------
   * Helpers
   * ------------------------------------------- */

  const canSelectMore =
    selectionLimit === 0 || selectedValues.length < selectionLimit;

  const availableSlots =
    selectionLimit === 0
      ? Infinity
      : Math.max(0, selectionLimit - selectedValues.length);

  const areAllFilteredSelected =
    displayedOptions.length > 0 &&
    displayedOptions.every((o) => selectedValues.includes(o.id));

  const areSomeFilteredSelected =
    displayedOptions.some((o) => selectedValues.includes(o.id)) &&
    !areAllFilteredSelected;

  /* ---------------------------------------------
   * Core fetch logic
   * ------------------------------------------- */

  const fetchPage = React.useCallback(
    async (reset: boolean) => {
      if (!onSearchRequest) return;

      setSearching(true);
      const reqId = ++lastReqId.current;

      const currentOffset = reset ? 0 : offset;

      try {
        const res = await onSearchRequest(
          searchTerm.trim(),
          currentOffset,
          pageSize
        );

        if (reqId !== lastReqId.current) return;

        setDisplayedOptions((prev) =>
          reset ? res.options : [...prev, ...res.options]
        );
        setHasMore(res.hasMore);
        setOffset(currentOffset + pageSize);
      } catch (err) {
        console.error("Dropdown fetch failed", err);
        if (reqId === lastReqId.current) {
          setDisplayedOptions(reset ? [] : displayedOptions);
          setHasMore(false);
        }
      } finally {
        if (reqId === lastReqId.current) {
          setSearching(false);
        }
      }
    },
    [onSearchRequest, offset, pageSize, searchTerm, displayedOptions]
  );

  /* ---------------------------------------------
   * Open / Close
   * ------------------------------------------- */

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    setOffset(0);
    setHasMore(true);
    fetchPage(true);
  };

  const handleClose = () => {
    setOpen(false);
    setSearchTerm("");
    setDisplayedOptions([]);
    setOffset(0);
    setHasMore(true);
  };

  /* ---------------------------------------------
   * Search (debounced)
   * ------------------------------------------- */

  React.useEffect(() => {
    if (!open) return;

    const handler = setTimeout(() => {
      setOffset(0);
      setHasMore(true);
      fetchPage(true);
    }, debounceMs);

    return () => clearTimeout(handler);
  }, [searchTerm, open, debounceMs, fetchPage]);

  React.useEffect(() => {
    if (open && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [open]);

  /* ---------------------------------------------
   * Selection handlers
   * ------------------------------------------- */

  const handleItemClick = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const isSelected = selectedValues.includes(id);

    let newSelected: string[];

    if (isSelected) {
      newSelected = selectedValues.filter((v) => v !== id);
    } else {
      if (!canSelectMore) return;
      newSelected = [...selectedValues, id];
    }

    onSelect(newSelected);
  };

  const handleSelectAll = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const ids = displayedOptions.map((o) => o.id);

    let newSelected: string[];

    if (areAllFilteredSelected) {
      const set = new Set(ids);
      newSelected = selectedValues.filter((v) => !set.has(v));
    } else {
      const toAdd = ids.filter((id) => !selectedValues.includes(id));
      if (selectionLimit > 0) {
        newSelected = [
          ...selectedValues,
          ...toAdd.slice(0, availableSlots),
        ];
      } else {
        newSelected = [...selectedValues, ...toAdd];
      }
    }

    onSelect(newSelected);
  };

  const getDisplayValue = () => {
    if (selectedValues.length === 0) return "";
    if (selectedValues.length <= 2) return `${selectedValues.length} selected`;
    return `${selectedValues.length} selected`;
  };

  /* ---------------------------------------------
   * Render
   * ------------------------------------------- */

  return (
    <FormControl fullWidth>
      <Select
        multiple
        open={open}
        onOpen={handleOpen}
        onClose={handleClose}
        value={selectedValues}
        onChange={(e: SelectChangeEvent<string[]>) => {}}
        input={<OutlinedInput notched={false} />}
        displayEmpty
        disabled={disabled}
        renderValue={(selected) =>
          (selected as string[]).length === 0 ? (
            <em>{placeholder}</em>
          ) : (
            getDisplayValue()
          )
        }
        MenuProps={MenuProps}
      >
        {/* Search */}
        <Box
          sx={{ p: 1, borderBottom: "1px solid #ddd" }}
          onClick={(e) => e.stopPropagation()}
        >
          <TextField
            inputRef={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search..."
            variant="standard"
            fullWidth
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Box>

        {/* Select All */}
        {displayedOptions.length > 0 && (
          <MenuItem onClick={handleSelectAll}>
            <Checkbox
              checked={areAllFilteredSelected}
              indeterminate={areSomeFilteredSelected}
            />
            <ListItemText primary="Select All" />
          </MenuItem>
        )}

        <Divider />

        {/* Options */}
        {displayedOptions.map((opt) => {
          const isSelected = selectedValues.includes(opt.id);
          const canSelectThis = isSelected || canSelectMore;

          return (
            <MenuItem
              key={opt.id}
              onClick={(e) => handleItemClick(opt.id, e)}
              disabled={!canSelectThis}
            >
              <Checkbox checked={isSelected} />
              <ListItemText primary={opt.label} />
            </MenuItem>
          );
        })}

        {/* Loading */}
        {searching && (
          <MenuItem disabled>
            <ListItemText primary="Loading..." />
          </MenuItem>
        )}

        {/* Load More */}
        {!searching && hasMore && (
          <MenuItem onClick={() => fetchPage(false)}>
            <ListItemText
              primary="Load more"
              secondary={`Showing ${displayedOptions.length}`}
            />
          </MenuItem>
        )}

        {/* Empty */}
        {!searching && displayedOptions.length === 0 && (
          <MenuItem disabled>
            <ListItemText primary="No results found" />
          </MenuItem>
        )}
      </Select>
    </FormControl>
  );
};

export default MultiSelectSearchableDropdown;
