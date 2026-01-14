import React, { useState, useEffect, useRef } from "react";
import {
	Box,
	Divider,
	Typography,
	Button,
	Card,
	TextField,
	InputAdornment,
	Select,
	MenuItem,
	OutlinedInput,
	FormControl,
	Paper,
	Breadcrumbs,
	FormHelperText,
	Tooltip,
	FormGroup,
	Checkbox,
	TablePagination
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { toast } from "react-toastify";
import Grid from "@mui/material/Grid2";
import IconButton from "@mui/material/IconButton";
import CardComponent from "../../components/cards/Card";
import AddIcon from "../../assets/images/add_2.svg";
import SearchIcon from "../../assets/images/search.svg";
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ReusableModal from "../../components/ReusableModal/ReusableModal";
import DataTable from "../../components/dataTable/DataTable";
import AribaMetadataTable from "../../components/dataTable/AribaMetadataTable";
import { columnList, columnsFileslist } from "../../constants/common";
import {
	createCW,
	DeleteCWrkspace,
	DeleteFiles,
	exportDocuments,
	getContractList,
	getCustomPanelList,
	getDocuments,
	updateContractDetails,
	uploadFiles,
	shareContract,
	unshareContract,
	getAribaMetadata,
	sendSelectedDocuments,
	getContractsForDropdowns
} from "@api/index";
import { useDispatch, useSelector } from "react-redux";
import { hideLoader, showLoader } from "../../store/loaderSlice";
import { showSnackbar } from "../../store/snackBarSlice";
import { useNavigate } from "react-router-dom";
import { setWorkspaceInStrore } from "../../store/commonSlice";
import { MultiSelectSearchableDropdown } from "../../components/MultiSelectSearchableDropdown/MultiSelectSearchableDropdown";
import { GridRenderCellParams, GridTreeNodeWithRender } from '@mui/x-data-grid'
import FilterListIcon from '@mui/icons-material/FilterList';
import Menu from '@mui/material/Menu';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import RadioGroup from '@mui/material/RadioGroup';
import Radio from '@mui/material/Radio';
import FormControlLabel from '@mui/material/FormControlLabel';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ShareIcon from '@mui/icons-material/Share';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DescriptionIcon from '@mui/icons-material/Description';
import Badge from '@mui/material/Badge';
import { RootState } from "@store/appStore";
import Pagination from '@mui/material/Pagination';

// Define a type for templates
interface Template {
	panel_id: string;
	panel_name: string;
	// Add other fields if needed
}
interface Document {
	name: string;
	parent_folder: string;
	id: string;
	last_modified_date: string;
	// Add other properties as needed
}

interface Params {
	value: string;
	// Add other properties as needed
}

const ContractManagement = () => {
	// third-party Hooks
	const theme = useTheme();
	const navigate = useNavigate();
	const dispatch = useDispatch();

	// Ref states
	const fileInputref = useRef<HTMLInputElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);

	const loading = useSelector((state: RootState) => state.loader.loading);
	const [uploadType, setUploadType] = useState<string>("Ariba");
	//const [uploadStatus, setUploadStatus] = useState<{ [key: string]: string }>({});
	const [uploadStatus, setUploadStatus] = useState<{ [key: string]: string }>({});
	const [isUploading, setIsUploading] = useState(false);
	const [viewFiles, setViewFiles] = useState(false);
	const [filesCount, setFilesCount] = useState(0);
	// Consts to handle Error Messages
	const [error, setError] = useState("");

	// Tracking Radio Button State
	//const [selectedCard, setSelectedCard] = useState<string | null>(null);

	// Modal states
	const [open, setOpen] = useState(false);
	const [modalIsOpen, setModalIsOpen] = useState(false);
	const [modalMessage, setModalMessage] = useState('');
	const [openEditModal, setOpenEditModal] = useState(false);
	const [openDeleteModal, setOpenDeleteModal] = useState(false);
	const [openDeleteFileModal, setOpenDeleteFileModal] = useState(false);
	// Utilities to ask for confirmation of sharing
	const [openShareModal, setOpenShareModal] = useState(false);
	const [actionType, setActionType] = useState<string | null>(null);
	const [openFilesModal, setOpenFilesModal] = useState(false);

	// Data states
	const [wrkspaceCards, setWrkSpaceCards] = useState([]);
	const [sharedContracts, setSharedContracts] = useState<Set<string>>(new Set());
	const [files, setFiles] = useState<File[]>([]);
	const [tableData, setTableData] = useState([]);
	const [availableDocuments, setAvailableDocuments] = useState<Document[]>([]);
	const [selectedDocuments, setSelectedDocuments] = useState<Array<{ document_id: string, last_modified_date: string }>>([]);

	// Tracking/Transition states
	const [search, setSearch] = useState("");
	const [comments, setComments] = useState("");
	const [contractType, setContractType] = useState<string>("");
	const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
	const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
	const [workspaceID, setWorkspaceID] = useState("");
	const [workspaceName, setWorkspaceName] = useState("");
	const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
	const [selectedContractName, setSelectedContractName] = useState<string | null>(null);
	const [contractIdInput, setContractIdInput] = useState("");
	// const [contractWorkspaceName, setContractWorkspaceName] = useState<string>("");
	const [contractWSAribaName, setContractWSAribaName] = useState<string>("");

	// Add state for selected department name
	const [selectedDepartmentName, setSelectedDepartmentName] = useState<string | null>(null);

	const [fetchAttempted, setFetchAttempted] = useState(false);
	const [filterAnchorEl, setFilterAnchorEl] = useState<null | HTMLElement>(null);

	// Add states to track the current applied filters separately from the UI selection
	const [templates, setTemplates] = useState<Template[]>([]);
	const [selectedTemplates, setSelectedTemplates] = useState<Template[]>([]);

	// Pagination states
	const [page, setPage] = useState(0);
	const [rowsPerPage, setRowsPerPage] = useState(10);
	const [totalCount, setTotalCount] = useState(30);
	// Specifically for contract workspaces
	const [cwPage, setCwPage] = useState(1);
	const [cwRowsPerPage, setCwRowsPerPage] = useState(19); // 19 items per page
	const [cwTotalCount, setCwTotalCount] = useState(0);


	// Contract WS Filters
	const [sortBy, setSortBy] = useState<string>("upload_date"); // Default sort by upload date
	const [sortOrder, setSortOrder] = useState<string>("desc"); // Default sort order is descending
	const [contractTypeFilters, setContractTypeFilters] = useState<string[]>([]);
	const [sharingTypeFilter, setSharingTypeFilter] = useState<string>("all");
	const [appliedSortBy, setAppliedSortBy] = useState<string>("upload_date");
	const [appliedSortOrder, setAppliedSortOrder] = useState<string>("desc");
	const [appliedContractTypeFilters, setAppliedContractTypeFilters] = useState<string[]>([]);
	const [appliedSharingTypeFilter, setAppliedSharingTypeFilter] = useState<string>("all");

	const templateOptions = Array.isArray(templates) ? templates.map(tpl => ({
		id: tpl.panel_id ?? '',
		label: tpl.panel_name ?? ''
	})) : [];

	const handleFilterClick = (event: React.MouseEvent<HTMLElement>) => {
		setFilterAnchorEl(event.currentTarget);
	};

	const handleFilterClose = () => {
		setFilterAnchorEl(null);
	};

	const handleSortChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setSortBy(event.target.value);
	};

	const handleSortOrderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setSortOrder(event.target.value);
	};

	const handleContractTypeChange = (event: React.ChangeEvent<HTMLInputElement>, contractType: string) => {
		if (contractType === "All Types") setContractTypeFilters([]);
		else {
			if (event.target.checked) {
				setContractTypeFilters(prev => [...prev, contractType]);
			} else {
				setContractTypeFilters(prev => prev.filter(type => type !== contractType));
			}
		}
	}

	const handleSharingTypeFilterChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setSharingTypeFilter(event.target.value);
	};

	// Add this function to check if any filters are active
	const areFiltersActive = () => {
		return appliedContractTypeFilters.length > 0 ||
			appliedSharingTypeFilter !== 'all' ||
			appliedSortBy !== 'upload_date' ||
			appliedSortOrder !== 'desc';
	};

	// Add this function to reset all filters to default
	const handleResetFilters = async () => {
		// Reset UI selection states
		setSortBy("upload_date");
		setSortOrder("desc");
		setContractTypeFilters([]);
		setSharingTypeFilter("all");

		// Reset applied filters
		setAppliedSortBy("upload_date");
		setAppliedSortOrder("desc");
		setAppliedContractTypeFilters([]);
		setAppliedSharingTypeFilter("all");

		// Reset pagination to first page
		setCwPage(0);

		// Trigger API call with reset filters
		await getContractLists(true);
	};

	const handleApplyFilters = async () => {
		// Reset to first page when applying new filters
		setCwPage(0);

		// Apply the UI selections to the applied filters
		setAppliedSortBy(sortBy);
		setAppliedSortOrder(sortOrder);
		setAppliedContractTypeFilters([...contractTypeFilters]);
		setAppliedSharingTypeFilter(sharingTypeFilter);

		// Close the filter menu
		handleFilterClose();

		// Show loader when applying filters
		getContractLists(true);
	}

	const handleTemplateChange = (selectedIds: string[]) => {
		// Type validation
		if (!Array.isArray(selectedIds)) {
			console.error('Expected array of template IDs');
			return;
		}

		// Validate each ID is a string
		if (selectedIds.some(id => typeof id !== 'string')) {
			console.error('All template IDs must be strings');
			return;
		}

		// Filter the selected templates from all templates, ensuring panel_id is compared as string
		const selected = (Array.isArray(templates) ? templates : []).filter(
			(t: any) => Array.isArray(selectedIds) && selectedIds.includes(t.panel_id)
		);

		// Set multiple selected templates, forcing panel_id as string
		setSelectedTemplates(selected || []);
	};

	useEffect(() => {
		if (files && files.length) {
			handleUploadFiles();
		}
	}, [files.length]);

	// handle Contract Management related pagination changes.
	// const handleCwPageChange = (event: React.ChangeEvent<unknown>, newPage: number) => {
	// 	setCwPage(newPage - 1); // Convert from 1-based to 0-based indexing
	// };

	const handleCWPageChange = (
		event: React.ChangeEvent<unknown>,
		newPage: number,
	) => {
		setCwPage(newPage);
	};

	// const handleCWsPerPageChange = (
	// 	event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
	// ) => {
	// 	// setRowsPerPage(parseInt(event.target.value, 19));
	// 	setCwRowsPerPage(parseInt(event.target.value, 19));
	// 	setCwPage(0);
	// };

	const fetchData = async (showLoader: boolean = true) => {
		if (viewFiles) {
			await getDocumentsPerWrkspace();
		} else {
			// Pass false to NOT show loader during polling
			await getContractLists(showLoader);
			// const data = await getContractsForDropdowns(search, true);
			// setCwTotalCount(data.toalCount);
		}
	};

	useEffect(() => {
		fetchData(true);
		let pollingInterval: any = setInterval(() => {
			fetchData(false);
		}, 15000);

		// Clean up interval on unmount or when dependencies change
		return () => clearInterval(pollingInterval);
	}, [viewFiles, search, cwRowsPerPage, cwPage, rowsPerPage, page, appliedSortBy, appliedSortOrder, appliedContractTypeFilters, appliedSharingTypeFilter]);

	useEffect(() => {
		const fetchTemplates = async () => {
			const res = await getCustomPanelList();
			if (res && res.data) {
				// Ensure all panel_id values are strings
				const templatesWithStringId = res.data.map((tpl: any) => ({
					...tpl,
					panel_id: String(tpl.panel_id),
				}));
				setTemplates(templatesWithStringId);
			}
		}
		fetchTemplates();
	}, []);

	// UseEffect to fetch shared status once
	useEffect(() => {
		const fetchSharedStatusForContracts = async () => {
			try {
				const offset = cwPage === 0 ? (cwPage * cwRowsPerPage) : ((cwPage-1) * cwRowsPerPage);
				const contractList = await getContractList(search, '', undefined, offset, cwRowsPerPage);

				if (contractList && contractList.success) {
					const sharedSet = new Set<string>();
					for (const contract of contractList.data.contracts) {
						// Use the shared column directly
						if (contract.shared === 1) {
							sharedSet.add(contract.contract_id);
						}
					}
					setSharedContracts(sharedSet);
				} else {
					console.error("Failed to fetch contract list or contract list is not successful.");
				}
			} catch (error) {
				console.error("Error fetching contract list:", error);
			}
		};
		fetchSharedStatusForContracts();
	}, []); // Empty dependency array ensures this runs only once

	const handleCheckboxChange = (contractId: string, contractName: string, departmentName: string) => {
		setSelectedContractId(contractId);
		setSelectedContractName(contractName);
		setSelectedDepartmentName(departmentName); // Update department name
		if (sharedContracts.has(contractId)) {
			// Open unshare modal
			setOpenShareModal(true);
		} else {
			// Open share modal
			setOpenShareModal(true);
		}
	};

	const handleShare = async () => {
		if (selectedContractId) {
			try {
				const response = await shareContract(selectedContractId);
				if (response.success) {
					toast.success(`Contract ${selectedContractName} shared successfully`);
					setSharedContracts((prev) => new Set(prev).add(selectedContractId));
				} else {
					toast.error(`Failed to share contract: ${response.message}`);
				}
			} catch (error) {
				console.error("Error sharing contract:", error);
				toast.error("An error occurred while sharing the contract");
			}
			setOpenShareModal(false); // Close the modal immediately
		}
	};


	const handleUnshare = async () => {
		if (selectedContractId) {
			try {
				const response = await unshareContract(selectedContractId);
				if (response.success) {
					toast.success(`Contract ${selectedContractName} unshared successfully`);
					setSharedContracts((prev) => {
						const updated = new Set(prev);
						updated.delete(selectedContractId);
						return updated;
					});
				} else {
					toast.error(`Failed to unshare contract: ${response.message}`);
				}
			} catch (error) {
				console.error("Error unsharing contract:", error);
				toast.error("An error occurred while unsharing the contract");
			}
			setOpenShareModal(false); // Close the modal immediately
		}
	};

	const closeShareModal = () => {
		setOpenShareModal(false);
		setSelectedContractId(null);
		setSelectedContractName(null);
	};

	const handleClose = () => {
		setOpen(false);
		setOpenFilesModal(false);
		setOpenEditModal(false)
		setFiles([]);
		setOpenDeleteModal(false)
		setError('');
		setOpenDeleteFileModal(false)
		setSelectedFileId("");
		setSelectedFileName("");
		setActionType("");
		setAvailableDocuments([]);
		setSelectedDocuments([]);
		// Reset contract ID input and workspace name when closing the popup
		setContractIdInput('');
		// setContractWorkspaceName('');
		setContractWSAribaName('');
		setComments('');
	};

	const handleDeleteClick = async (type: string, fileId: string, fileName: string) => {
		setSelectedFileId(fileId);
		setSelectedFileName(fileName);
		setActionType(type);
		if (type === "delete") {
			setOpenDeleteFileModal(true);
		} else if (type === "download") {
			const resp: any = await exportDocuments(fileId, fileName);
		}
	};

	// api to call contract lists
	const getContractLists = async (showLoaderVal = false) => {
		try {
			// Only show loader on initial page load or when filters are applied
			if (showLoaderVal) {
				dispatch(showLoader());
			}

			// Use the applied filter values, not the UI selection states
			let sortParam = '';
			if (appliedSortBy === 'alphabetic') {
				sortParam = appliedSortOrder === 'asc' ? 'name_asc' : 'name_desc';
			} else if (appliedSortBy === 'upload_date') {
				sortParam = appliedSortOrder === 'asc' ? 'date_asc' : 'date_desc';
			}

			// Create filter parameters using applied filters
			const filterParams: any = {};

			// Add contract types if selected (as a comma-separated string)
			if (appliedContractTypeFilters.length > 0) {
				filterParams.contractTypes = appliedContractTypeFilters.join(',');
			}

			// Add sharing type if not "all"
			if (appliedSharingTypeFilter !== 'all') {
				filterParams.sharingType = appliedSharingTypeFilter;
			}

			// Add pagination parameters
			//filterParams.page = cwPage + 1; // Convert to 1-based for API
			//filterParams.per_page = cwRowsPerPage;

			// Call the API with search term, sort parameter, and filters
			console.log(`cwPage: ${cwPage}`);
			const offset = cwPage === 0 ? (cwPage * cwRowsPerPage) : ((cwPage-1) * cwRowsPerPage);
			const resp = await getContractList(search, sortParam, filterParams, offset, cwRowsPerPage);

			if (resp && resp.success) {
				// Store all contracts from the API response
				const allContracts = resp.data.contracts;

				console.log(`totalCount: ${resp.data.total_count}`);
				// Set the total count for pagination calculation
				setCwTotalCount(resp.data.total_count);

				// // Calculate the start and end indices for the current page
				// const startIndex = cwPage * cwRowsPerPage;
				// const endIndex = Math.min(startIndex + cwRowsPerPage, allContracts.length);

				// // Slice the array to get only the contracts for the current page
				// const paginatedContracts = allContracts.slice(startIndex, endIndex);
				// setWrkSpaceCards(paginatedContracts);

				setWrkSpaceCards(allContracts);
			} else {
				dispatch(
					showSnackbar({
						message: `${resp.message}`,
						severity: "error",
					})
				);
			}
			return resp;

		} catch (error) {
			console.error("Error fetching contract lists:", error);
			dispatch(
				showSnackbar({
					message: "Failed to fetch contract lists",
					severity: "error",
				})
			);
		} finally {
			if (showLoaderVal) {
				dispatch(hideLoader());
			}
		}
	};

	const handleOpen = () => {
		setOpen(true);
		setSelectedTemplates([]); // Reset template dropdown selection
		resettingConfig();
	};


	// Handle file selection
	const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFiles = event.target.files;
		if (selectedFiles && selectedFiles.length > 0) {
			// if workspaceID is not there means new CW creation.
			if (!workspaceID) await createContractWorkspace();

			setFiles(Array.from(selectedFiles));
			const initialStatus: { [key: string]: string } = {};

			Array.from(selectedFiles).forEach((file) => {
				initialStatus[file.name] = "Pending";
			});

			setUploadStatus(initialStatus);
			if (fileInputref?.current) {
				fileInputref.current.value = '';
			}
		}
	};


	// Handle file upload
	const handleUploadFiles = async () => {
		setIsUploading(true); // Set uploading to true to show progress
		const updatedStatus = { ...uploadStatus }; // Copy the current uploadStatus to modify it directly

		for (const file of files) {
			// Mark the file as "Uploading" immediately
			updatedStatus[file.name] = "Uploading";

			// Set state with the new status
			// setUploadStatus({ ...updatedStatus });
			const formData = new FormData();
			formData.append("file", file);
			setUploadStatus((prev) => ({
				...prev,
				[file.name]: "Uploading",
			}));

			try {
				await uploadFiles(formData, workspaceID);
				await getContractLists(false);

				// const status = await mockApiUpload(file.name); // Wait for the mock API to return
				updatedStatus[file.name] = "Uploaded";
				setUploadStatus({ ...updatedStatus });
			} catch (error) {
				updatedStatus[file.name] = "Failed";
				setUploadStatus({ ...updatedStatus });
			}
		}
		getDocumentsPerWrkspace();
		setIsUploading(false); // End uploading process
	};

	const handleUploads = async () => {
		setError("");
		if (!workspaceName) {
			setError("Required field");
			return;
		}
		openUploadModal();
	};

	const createContractWorkspace = async () => {
		try {
			const payload = {
				contract_workspace_name: workspaceName,
				comments: comments,
				templates: selectedTemplates.map(t => t.panel_id),
				contract_type: contractType,
			};

			const response = await createCW(payload);

			if (response && response.success) {
				setWorkspaceID(response.data.contract_workspace_id);

				// Show success snackbar
				dispatch(showSnackbar({
					message: 'Contract workspace created successfully',
					severity: 'success',
				}));
			} else {
				setError(`${response.payload}`);

				dispatch(showSnackbar({
					message: response?.payload || 'Failed to create contract workspace',
					severity: 'error',
				}));
			}
		} catch (error) {
			console.error('Error in createContractWorkspace:', error);
			setError('An unexpected error occurred');

			dispatch(showSnackbar({
				message: 'An error occurred while creating the contract workspace',
				severity: 'error',
			}));
		}
	}

	const handleAddFile = () => {
		openUploadModal();
	}

	const openUploadModal = () => {
		document.getElementById("file-input")?.click();
	};

	function removeCpiPrefixConditional(input: string): string {
		const prefix = "CPI-";
		if (uploadType === 'Ariba' && input.startsWith(prefix)) {
			return input.substring(prefix.length);
		}
		return input;
	}

	const handleViewFiles = async (id: any, name: any, ariba_contract_ws_name: string, contract_source: string, count: any) => {
		setWorkspaceID(id);
		setWorkspaceName(name);
		setContractWSAribaName(ariba_contract_ws_name);
		setUploadType(contract_source);
		setViewFiles(true);
		setSearch("");
		// await getDocumentsPerWrkspace(id, name);
	};

	const handleBreadCrumb = () => {
		resettingConfig();
		setViewFiles(false);
	};

	const resettingConfig = () => {
		setWorkspaceID("");
		setError('')
		setComments('')
		setWorkspaceName("");
		setContractWSAribaName("");
		setUploadType('Ariba');
		setContractType('');
		setFetchAttempted(false);
	};

	const getDocumentsPerWrkspace = async () => {
		const resp = await getDocuments(workspaceID, search, page + 1, rowsPerPage);
		setTableData(resp.data.files);
		setFilesCount(resp.data.files.length);
		const { total_items } = resp?.pagination;
		setTotalCount(total_items);
		return resp;
	};

	const handleActions = async (type: any, id: any, comments: string, workspaceName: string, ariba_contract_ws_name: string, contract_type: string, contract_source: string) => {
		setWorkspaceID(id);
		setWorkspaceName(workspaceName);
		setContractWSAribaName(ariba_contract_ws_name);

		const payload = {
			contract_id: id,
			contract_worspace: workspaceName
		}
		if (type.id === "delete") {
			setOpenDeleteModal(true);
		} else if (type.id === "add") {
			addFiles();
		} else if (type.id === "update") {
			setOpenEditModal(true)
			setComments(comments)
			setUploadType(contract_source)
			setContractType(contract_type)
		} else if (type.id === "insight") {
			dispatch(setWorkspaceInStrore(payload))
			navigate("/homepage/intelligence")
		} else if (type.id === "attributes") {
			dispatch(setWorkspaceInStrore(payload))
			navigate("/homepage/attributes", { state: { viewType: 'contract' } })
		}

		// await getContractLists(false);
	};


	const handleDelete = async () => {
		if (workspaceID) {
			const resp = await DeleteCWrkspace(workspaceID);
			if (resp.success) {
				dispatch(
					showSnackbar({
						message: `${resp.message}`,
						severity: "success",
					}),
				);
				resettingConfig();
				handleClose();

				// if (search === workspaceName || `CPI-${search}` === workspaceName) setSearch("");

				// const filtered: any[] = wrkspaceCards.filter((item: any) => item.contract_workspace.includes(search));
				// if (filtered.length === 1 && filtered[0].contract_workspace === workspaceName) setSearch("");

				await getContractLists(false);
			} else {
				dispatch(
					showSnackbar({
						message: `${resp.payload}`,
						severity: "error",
					}),
				);
			}
		}
	}

	const handleDeleteFile = async () => {
		if (selectedFileId) {
			if (actionType === "delete") {
				const resp = await DeleteFiles(selectedFileId);
				if (resp.success) {
					dispatch(
						showSnackbar({
							message: `${resp.message}`,
							severity: "success",
						}),
					);
					await getDocumentsPerWrkspace();
					handleClose();

					const filtered: any[] = tableData.filter((item: any) => item.file_name.includes(search));
					if (filtered.length === 1 && filtered[0]?.file_name === selectedFileName) setSearch("");
				} else {
					dispatch(
						showSnackbar({
							message: `${resp.payload}`,
							severity: "error",
						}),
					);
				}
			}
		}
	};

	const addFiles = () => {
		// openUploadModal();
		setOpenFilesModal(true);
	};

	const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
		// const target = e.target as HTMLInputElement;
		setSearch(e.target.value);
	};

	// Search Contract Workspaces based on search
	const handleCWSearchClick = () => {
		if (searchInputRef.current && !loading) {
			setSearch(searchInputRef.current.value);
			setCwPage(0); // Reset to first page when searching
			console.log('Searching for:', searchInputRef.current.value);
		}
	};

	const handleCWSearchEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault(); // Prevent form submission if inside a form
			handleCWSearchClick();
		}
	};

	const handleUpdateWorkspace = async () => {
		try {
			const payload = {
				contract_workspace_id: workspaceID,
				comments: comments,
				contract_type: contractType,
				templates: selectedTemplates.map(t => t.panel_id)
			};

			const response = await updateContractDetails(payload);

			if (response && response.success) {
				await getContractLists(false);
				resettingConfig();
				handleClose();

				// Show success snackbar
				dispatch(showSnackbar({
					message: 'Contract updated successfully',
					severity: 'success',
				}));
			} else {
				dispatch(showSnackbar({
					message: response?.message || 'Failed to update contract',
					severity: 'error',
				}));
			}
		} catch (error) {
			console.error('Error in handleUpdateWorkspace:', error);

			dispatch(showSnackbar({
				message: 'An error occurred while updating the contract',
				severity: 'error',
			}));
		}
	}

	const fetchDocumentsForDocumentId = async (documentId: string) => {
		try {
			const response = await getAribaMetadata(documentId);
			setFetchAttempted(true);
			// Check if response contains an error from the backend about Draft state
			if (response.data && response.data.error) {
				// Handle the specific error for Draft state Contract Workspace
				setModalMessage(response.data.error);
				setModalIsOpen(true);
				return;
			}
			if (response.success) {
				const documents = response.data.documents || [];
				if (response.data.length === 0) {
					// Set modal message for empty array response
					setModalMessage("It seems that the provided contract workspace doesn’t have any pdf documents.");
					setModalIsOpen(true);
				} else {
					toast.success(`Ariba Metadata for ${documentId} fetched successfully`);
					// Set the workspace name in the UI (you'll need to add a state variable for this)
					if (response.data?.workspace_name) {
						// setContractWorkspaceName(response.data.workspace_name);
						setContractWSAribaName(response.data.workspace_name);
					}
					// Set the documents in the state
					setAvailableDocuments(documents);
					//const documentIds = response.data.map((doc: Document) => doc.id);
				}
			} else {
				// Handle specific error codes based on response payload
				const errorMessage = `${response.message} - ${response.payload}` || `Failed to fetch metadata for: ${documentId}`;

				if (response.payload.includes("429")) {
					setModalMessage("Apologies. API limit was reached, please try again in 10 seconds. If the issue persists, please contact the Administrators.");
				} else if (response.payload.includes("400")) {
					setModalMessage("It seems that you don't have access to the requested contract workspace. If you think it’s an error, please contact the administrator.");
				} else if (response.payload.includes("401")) {
					setModalMessage("It seems that you don't have access to the requested contract workspace. If you think it’s an error, please contact the administrator.");
				} else if (response.payload.includes("500")) {
					setModalMessage("Error 500: internal error. If the error persist please contact the Administrator");
				} else if (response.payload.includes("404")) {
					setModalMessage("It seems that the Contract ID you entered does not exist. Please try again and notify the Administrator if you think that it may be an error.");

				} else {
					setModalMessage(errorMessage);
				}
				setModalIsOpen(true);
				setAvailableDocuments([]);
			}

		} catch (error) {
			console.error("Error while fetching the contract:", error);
			// Handle specific error codes
			setModalMessage("An error occurred while fetching the contracts");
			setModalIsOpen(true);
			setAvailableDocuments([]);
		}

	}


	// Replace the existing handleSelectionChange function with this one
	const handleSelectionChange = (selectedDocs: Array<{ document_id: string, last_modified_date: string }>) => {
		// Simply set the selected documents directly
		setSelectedDocuments(selectedDocs);
	};


	// Define a custom cell renderer function
	const renderDocumentName = (params: GridRenderCellParams<any, any, any, GridTreeNodeWithRender>) => (
		<Tooltip title={params.value}>
			<span style={{
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap', // Change to 'normal' for text wrapping
				display: 'block', // Ensures block-level element for wrapping
				maxWidth: '100%', // Ensures it fits within the cell
			}}>
				{params.value}
			</span>
		</Tooltip>
	);

	const submitSelectedDocuments = async () => {
		try {
			if (selectedDocuments.length === 0) {
				console.error('No documents selected for submission.');
				return;
			}

			// Extract document IDs from the selectedDocuments objects
			const documentIds = selectedDocuments.map(doc => doc.document_id).join(',');

			// Create a proper object for last_modified_dates
			const lastModifiedDatesObj: { [key: string]: string } = {};
			selectedDocuments.forEach(doc => {
				lastModifiedDatesObj[doc.document_id] = doc.last_modified_date;
			});

			const payload = {
				contract_workspace_name: contractIdInput,
				ariba_contract_ws_name: contractWSAribaName,
				document_ids: documentIds,
				templates: selectedTemplates.map(t => t.panel_id),
				contract_type: contractType,
				comments,
				last_modified_dates: JSON.stringify(lastModifiedDatesObj), // Stringify the object
			};
			handleClose();

			const response = await sendSelectedDocuments(payload);

			if (response && response.success) {
				await getContractLists(false);

				// Reset states
				setAvailableDocuments([]);
				setSelectedDocuments([]);
				setContractIdInput('');
				// setContractWorkspaceName('');
				setContractWSAribaName('');
				setSearch('');

				// Show success snackbar
				dispatch(showSnackbar({
					message: 'Contract created successfully',
					severity: 'success',
				}));
			} else {
				dispatch(showSnackbar({
					message: response?.message || 'Failed to create Contract',
					severity: 'error',
				}));
			}
		} catch (error) {
			console.error('Error in submitSelectedDocuments:', error);
			dispatch(showSnackbar({
				message: 'An error occurred while creating the contract',
				severity: 'error',
			}));
		} finally {
			dispatch(hideLoader());
		}
	};

	return (
		<Grid
			container
			sx={{ width: "100%", justifyContent: "center", height: "95vh" }}
		>
			<Grid
				sx={{
					flex: 1,
					mt: 8,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					background: "#fff",
					boxShadow:
						"0px 2px 4px rgba(0, 0, 0, 0.14), 0px 0px 2px rgba(0, 0, 0, 0.12)",
					borderRadius: "8px",
					width: "100%",
				}}
			>
				<Grid
					container
					sx={{ width: "100%" }}
					justifyContent="space-between"
				>
					<Typography
						align="center"
						sx={{ fontSize: "1.5rem", px: 2, p: 1.5 }}
					>
						Contract Management
					</Typography>
					<Divider sx={{ width: "100%" }} />
				</Grid>
				{!viewFiles ? (
					<>
						<Grid
							container
							sx={{ width: "100%", p: 1.5 }}
							justifyContent="space-between"
							alignItems="center"
						>
							<Typography
								align="center"
								variant="h1"
								sx={{ fontSize: "1.15rem" }}
							>
								Contract Workspaces
							</Typography>
							<Box sx={{ display: 'flex', alignItems: 'center' }}>
								<Button
									sx={{ mr: 1 }}
									variant="contained"
									color="primary"
									disabled={loading}
									onClick={handleCWSearchClick}
									title="Search"
								// startIcon={<img src={SearchIcon} alt="Search" />}
								>
									Search
								</Button>
								<TextField
									inputRef={searchInputRef}
									// value={search}
									defaultValue=''
									variant="outlined"
									size="small"
									placeholder="Search Contract Name"
									slotProps={{
										input: {
											startAdornment: (
												<InputAdornment position="start">
													<img src={SearchIcon} alt="Search" />
												</InputAdornment>
											),
										},
									}}
									fullWidth
									onKeyDown={handleCWSearchEnter}
									// onChange={handleSearch}
									sx={{ width: 500, height: 42, mr: 1 }}
								/>
								<Tooltip title="Filter and Sort">
									<Badge
										color="primary"
										variant="dot"
										invisible={!areFiltersActive()}
										sx={{ '& .MuiBadge-badge': { right: 6, top: 6 } }}
									>
										<IconButton
											onClick={handleFilterClick}
											sx={{
												border: '1px solid rgba(0, 0, 0, 0.23)',
												borderRadius: '4px',
												height: 42,
												width: 42
											}}
										>
											<FilterListIcon />
										</IconButton>
									</Badge>
								</Tooltip>
								<Menu
									anchorEl={filterAnchorEl}
									open={Boolean(filterAnchorEl)}
									onClose={handleFilterClose}
									slotProps={{
										paper: {
											sx: {
												width: 320,
												maxHeight: {
													xs: 'calc(100vh - 80px)',  // Mobile
													sm: 'calc(100vh - 96px)',  // Tablet
													md: 'calc(100vh - 112px)'  // Desktop
												},
												p: 1,
												overflowY: 'auto'
											}
										},
										list: {
											'aria-labelledby': 'long-button',
										},
									}}
								>
									<Typography variant="subtitle1" sx={{ px: 2, py: 1, fontWeight: 'bold' }}>
										Sort By
									</Typography>
									<RadioGroup
										value={sortBy}
										onChange={handleSortChange}
										sx={{ px: 2 }}
									>
										<FormControlLabel
											value="upload_date"
											control={<Radio size="small" />}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<CalendarTodayIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Upload Date" />
												</Box>
											}
										/>
										<FormControlLabel
											value="alphabetic"
											control={<Radio size="small" />}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<SortByAlphaIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Alphabetic Order" />
												</Box>
											}
										/>
									</RadioGroup>

									{/* Add Sort Order section */}
									<Typography variant="subtitle1" sx={{ px: 2, py: 1, fontWeight: 'bold', mt: 1 }}>
										Sort Order
									</Typography>
									<RadioGroup
										value={sortOrder}
										onChange={handleSortOrderChange}
										sx={{ px: 2 }}
									>
										<FormControlLabel
											value="asc"
											control={<Radio size="small" />}
											label="Ascending"
										/>
										<FormControlLabel
											value="desc"
											control={<Radio size="small" />}
											label="Descending"
										/>
									</RadioGroup>

									<Divider sx={{ my: 1.5 }} />
									<Typography variant="subtitle1" sx={{ px: 2, py: 1, fontWeight: 'bold' }}>
										Contract Type
									</Typography>
									<FormGroup sx={{ px: 2 }}>
										<FormControlLabel
											control={
												<Checkbox
													size="small"
													checked={contractTypeFilters.length === 0}
													onChange={(e) => handleContractTypeChange(e, "All Types")}
												/>
											}
											label="All Types"
										/>
										<FormControlLabel
											control={
												<Checkbox
													size="small"
													checked={contractTypeFilters.includes("MSA")}
													onChange={(e) => handleContractTypeChange(e, "MSA")}
												/>
											}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<DescriptionIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="MSA" />
												</Box>
											}
										/>
										<FormControlLabel
											control={
												<Checkbox
													size="small"
													checked={contractTypeFilters.includes("Container Agreement")}
													onChange={(e) => handleContractTypeChange(e, "Container Agreement")}
												/>
											}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<DescriptionIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Container Agreement" />
												</Box>
											}
										/>
										<FormControlLabel
											control={
												<Checkbox
													size="small"
													checked={contractTypeFilters.includes("Project Agreement")}
													onChange={(e) => handleContractTypeChange(e, "Project Agreement")}
												/>
											}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<DescriptionIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Project Agreement" />
												</Box>
											}
										/>
										<FormControlLabel
											control={
												<Checkbox
													size="small"
													checked={contractTypeFilters.includes("Sub-Agreement")}
													onChange={(e) => handleContractTypeChange(e, "Sub-Agreement")}
												/>
											}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<DescriptionIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Sub-Agreement" />
												</Box>
											}
										/>
									</FormGroup>

									<Divider sx={{ my: 1.5 }} />

									<Typography variant="subtitle1" sx={{ px: 2, py: 1, fontWeight: 'bold' }}>
										Sharing Type
									</Typography>
									<RadioGroup
										value={sharingTypeFilter}
										onChange={handleSharingTypeFilterChange}
										sx={{ px: 2 }}
									>
										<FormControlLabel
											value="all"
											control={<Radio size="small" />}
											label="All"
										/>
										<FormControlLabel
											value="uploaded"
											control={<Radio size="small" />}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<UploadFileIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Uploaded by me" />
												</Box>
											}
										/>
										<FormControlLabel
											value="shared"
											control={<Radio size="small" />}
											label={
												<Box sx={{ display: 'flex', alignItems: 'center' }}>
													<ListItemIcon sx={{ minWidth: 36 }}>
														<ShareIcon fontSize="small" />
													</ListItemIcon>
													<ListItemText primary="Shared from team" />
												</Box>
											}
										/>
									</RadioGroup>

									<Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2, px: 2 }}>
										<Button
											color="secondary"
											variant="outlined"
											onClick={handleResetFilters}
											sx={{ textTransform: 'none', mr: 3 }}
										>
											Reset Filters
										</Button>
										<Button
											variant="contained"
											onClick={handleApplyFilters}
											sx={{ textTransform: 'none' }}
										>
											Apply Filters
										</Button>
									</Box>
								</Menu>
							</Box>
						</Grid>

						<Grid
							justifyContent="flex-start"
							alignItems="center"
							sx={{
								width: "100%",
								display: "flex",
								flexDirection: "row",
							}}
						>
							<Grid container spacing={2} sx={{ p: 1.5 }}>
								{/* Add New Workspace Card */}
								<Grid>
									<Card
										variant="outlined"
										sx={{
											height: {
												lg: "280px",
											},
											width: {
												lg: "320px",
												xl: "375px"
											},
											display: "flex",
											justifyContent: "center",
											alignItems: "center",
											borderRadius: 2,
											border: 3,
											borderColor: theme.palette.secondary.main,
										}}
									>
										<Box textAlign="center">
											<IconButton
												size="large"
												color="primary"
												onClick={handleOpen}
											>
												<img src={AddIcon} alt="Add" />
											</IconButton>
											<Typography
												variant="body2"
												sx={{ px: 8, pt: 1 }}
											>
												Click to create a new Contract Workspace
											</Typography>
										</Box>
									</Card>
								</Grid>

								{/* No Results Message - Displayed at the top when no contracts are found */}
								{wrkspaceCards && wrkspaceCards.length === 0 && (areFiltersActive() || search) && (
									<Box
										sx={{
											position: 'absolute',
											left: '50%',
											top: '50%',
											transform: 'translate(-50%, -50%)',
											width: '100%',
											textAlign: 'center',
											pointerEvents: 'none',
										}}
									>
										<Typography
											variant="h6"
											color="text.secondary"
											sx={{
												fontWeight: 600,
											}}
										>
											No contracts found for the applied filter
										</Typography>
									</Box>
								)}

								{/* Existing Workspace Cards */}
								{wrkspaceCards && wrkspaceCards.length > 0 && wrkspaceCards.map((card: any) => (
									<CardComponent
										key={card.contract_id}
										{...card}
										onClickCard={handleViewFiles}
										onActionClicked={handleActions}
										selected={sharedContracts.has(card.contract_id)}
										onCheckboxChange={() => handleCheckboxChange(card.contract_id, card.contract_workspace, card.department_name)}
									/>
								))}
							</Grid>
						</Grid>

						{/* ADD PAGINATION COMPONENT RIGHT HERE */}
						{wrkspaceCards && wrkspaceCards.length > 0 && (
							<Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, mb: 3 }}>
								{/* <InfinitePaginationAction page={page} setPage={handleCWPageChange} hasNext={true} /> */}
								<Pagination
									count={Math.ceil(cwTotalCount / cwRowsPerPage) - 1}
									page={cwPage}
									onChange={handleCWPageChange}
									color="primary"
									size="large"
									// siblingCount={1}
									// boundaryCount={0}
									// hidePrevButton={cwPage == 0}
									// hideNextButton={cwPage == 1}
								/>
							</Box>
						)}
					</>
				) : (
					<>
						<Box sx={{ width: "100%", p: 2 }}>
							{/* Header Section */}
							<Grid
								container
								spacing={2}
								alignItems="center"
								sx={{ marginBottom: 2 }}
							>
							</Grid>
							{/* Breadcrumb */}
							<Grid
								container
								spacing={2}
								alignItems="center"
								sx={{ marginBottom: 2 }}
							>
								{/* Breadcrumbs */}
								<Grid>
									<Breadcrumbs
										separator=">"
										aria-label="breadcrumb"
									>
										<Typography
											color="secondary"
											sx={{
												cursor: "pointer",
											}}
											onClick={handleBreadCrumb}
										>
											Contract Management
										</Typography>
										<Typography color="textPrimary">
											{removeCpiPrefixConditional(workspaceName)} - {contractWSAribaName} ({filesCount})
										</Typography>
									</Breadcrumbs>
								</Grid>
							</Grid>
							{/* Search Bar and Add Files Button */}
							<Grid
								display="flex"
								alignItems="center"
								justifyContent="space-between"
								sx={{ pb: 2 }}
							>
								<Grid>
									<TextField
										value={search}
										variant="outlined"
										size="small"
										placeholder="Search"
										slotProps={{
											input: {
												startAdornment: (
													<InputAdornment position="start">
														<img
															src={SearchIcon}
															alt="Search"
														/>
													</InputAdornment>
												),
											},
										}}
										fullWidth
										onChange={handleSearch}
										sx={{ width: 500, height: 42 }}
									/>
								</Grid>
								<Grid>
									<Button
										variant="outlined"
										sx={{ width: 150 }}
										onClick={addFiles}
									>
										Add Files
									</Button>
								</Grid>
							</Grid>

							{/* Table Section */}
							<Paper>
								<DataTable
									data={tableData}
									columns={columnList}
									page={page}
									totalCount={totalCount}
									setPage={setPage}
									rowsPerPage={rowsPerPage}
									setRowsPerPage={setRowsPerPage}
									onDelete={handleDeleteClick}
								/>
							</Paper>
						</Box>
					</>
				)}
			</Grid>

			<ReusableModal
				open={open}
				onClose={handleClose}
				title="Create Contract Workspace"
				content={
					<Box>
						{/* Row of dropdowns */}
						<Grid container spacing={5} sx={{ mb: 2 }}>
							{/* Upload Type */}
							<Grid>
								<Box sx={{ display: 'flex', flexDirection: 'column' }}>
									<Typography sx={{ mb: 1 }}>Upload Type (Ariba/Manual)</Typography>
									<Select
										value={uploadType}
										onChange={(e) => setUploadType(e.target.value)}
										displayEmpty
										disabled={files.length > 0}
										sx={{ width: '250px' }}
									>
										<MenuItem value="" disabled>
											Select Upload Type
										</MenuItem>
										<MenuItem value="Ariba">Ariba</MenuItem>
										<MenuItem value="Manual">Manual</MenuItem>
									</Select>
								</Box>
							</Grid>

							{/* Template */}
							<Grid>
								<Box sx={{ display: 'flex', flexDirection: 'column' }}>
									<Box sx={{ display: 'flex', alignItems: 'center' }}>
										<Typography sx={{ mr: 1 }}>Analysis Template</Typography>
										<Tooltip title="To process a set of questions for the contract">
											<span style={{ cursor: 'pointer', display: 'flex' }}>
												<InfoOutlinedIcon sx={{ fontSize: 20, color: '#1976d2' }} />
											</span>
										</Tooltip>
									</Box>
									<MultiSelectSearchableDropdown
										selectedValues={Array.isArray(selectedTemplates) ? selectedTemplates.map(t => t.panel_id) : []}
										onSelect={handleTemplateChange}
										placeholder="Select Your Analysis Templates"
										disabled={files.length > 0}
										selectionLimit={0} // Allow unlimited selection, enabling "Select All"
									/>
								</Box>
							</Grid>

							{/* Contract Type*/}
							<Grid size={5}>
								<Box sx={{ display: 'flex', flexDirection: 'column' }}>
									<Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
										<Typography sx={{ mr: 1 }}>Contract Type</Typography>
									</Box>
									<Select
										value={contractType}
										onChange={(e) => setContractType(e.target.value)}
										displayEmpty
										disabled={files.length > 0}
										sx={{ width: '250px' }}
										renderValue={(selected) => {
											if (!selected) {
												return <Typography
													component="em"
													sx={{
														color: 'text.secondary',
														fontStyle: 'italic',
														opacity: 0.7,
														fontSize: '0.875rem'
													}}
												>
													Select Contract Type (Optional)
												</Typography>;
											}
											return selected;
										}}
									>
										<MenuItem value="">
											<em>None</em>
										</MenuItem>
										<MenuItem value="MSA">MSA</MenuItem>
										<MenuItem value="Container Agreement">Container Agreement</MenuItem>
										<MenuItem value="Project Agreement">Project Agreement</MenuItem>
										<MenuItem value="Sub-Agreement">Sub-Agreement</MenuItem>
									</Select>
								</Box>
							</Grid>
						</Grid>

						{/* Manual upload type specific fields */}
						{uploadType === "Manual" && (
							<Grid container spacing={2} sx={{ width: "895px", mb: 2 }}>
								{/* Contract WS name */}
								<Grid size={12}>
									<FormControl sx={{ width: "100%" }} variant="outlined" error={!!error}>
										<Typography>Enter New Workspace Name</Typography>
										<Box sx={{ mt: '2px' }}>
											<OutlinedInput
												id="workspace-name"
												aria-describedby="workspace-helper-text"
												style={{ width: `100%` }}
												value={workspaceName}
												disabled={files.length > 0}
												onChange={(e) => setWorkspaceName(e.target.value)}
												inputProps={{
													"aria-label": "Workspace Name",
												}}
												required
											/>
											{error && (
												<Box sx={{ position: 'absolute' }}>
													<FormHelperText id="workspace-helper-text">
														{error}
													</FormHelperText>
												</Box>
											)}
										</Box>
									</FormControl>
								</Grid>

								<Grid size={12}>
									<FormControl sx={{ width: "100%" }} variant="outlined">
										<Typography>Comments</Typography>
										<OutlinedInput
											id="comments"
											aria-describedby="comments-helper-text"
											value={comments}
											disabled={files.length > 0}
											onChange={(e) => setComments(e.target.value)}
											inputProps={{
												"aria-label": "Comments",
											}}
										/>
									</FormControl>
								</Grid>
							</Grid>
						)}

						{/* Files list with divider above and scrolling for more than 4 files */}
						{files.length > 0 && (
							<>
								<Divider sx={{ my: 3, borderColor: 'rgba(0, 0, 0, 0.12)' }} />
								<Box>
									<Box sx={{
										display: 'flex',
										justifyContent: 'space-between',
										alignItems: 'center',
										mb: 1
									}}>
										<Typography variant="h6">Total Files ({files.length})</Typography>
									</Box>

									<Box
										sx={{
											maxHeight: files.length > 4 ? '200px' : 'auto',
											overflow: files.length > 4 ? 'auto' : 'visible',
											border: files.length > 4 ? '1px solid rgba(0, 0, 0, 0.12)' : 'none',
											borderRadius: '4px'
										}}
									>
										<Paper elevation={1} sx={{ height: '100%' }}>
											<DataTable
												data={files.map((file) => ({
													file_name: file.name,
													status: uploadStatus[file.name] || "Pending",
												}))}
												columns={columnsFileslist}
												page={page}
												totalCount={files.length}
												setPage={setPage}
												rowsPerPage={rowsPerPage}
												setRowsPerPage={setRowsPerPage}
												showPagination={files.length > rowsPerPage}
											/>
										</Paper>
									</Box>
								</Box>
							</>
						)}

						{/* Ariba upload type specific fields - Modified to show document table only after fetch */}
						{uploadType === "Ariba" && (
							<>
								{/* Contract ID input and fetch button - Always visible */}
								<Box sx={{ mt: 2 }}>
									<Typography variant="subtitle1" sx={{ mb: 1 }}>Enter Contract ID</Typography>
									<Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
										<TextField
											variant="outlined"
											value={contractIdInput}
											onChange={(e) => setContractIdInput(e.target.value)}
											placeholder="Contract ID"
											sx={{ width: '250px', mr: 2 }}
										/>
										<Button
											variant="contained"
											onClick={() => fetchDocumentsForDocumentId(contractIdInput)}
											sx={{ width: '250px', mr: 2, ml: 2, mb: 2, mt: 2 }}
										>
											Fetch Documents
										</Button>
									</Box>

									{/* Footnote - Always visible */}
									<Typography
										variant="body2"
										color="textSecondary"
										sx={{
											mt: 2,
											fontStyle: 'italic',
										}}
									>
										* Please note that you can retrieve only published and active contracts you
										already have access to in Ariba.
									</Typography>

									{contractWSAribaName && (
										<FormControl sx={{ width: "80%", mt: "2px" }} variant="outlined">
											<Typography>Ariba Contract Workspace Name</Typography>
											<OutlinedInput
												id="ariba-contract-ws-name"
												aria-describedby="ariba-name-helper-text"
												value={contractWSAribaName}
												disabled
												inputProps={{
													"aria-label": "Ariba Contract Workspace Name",
												}}
											/>
										</FormControl>
									)}

									<FormControl sx={{ width: "80%", mt: "2px" }} variant="outlined">
										<Typography>Comments</Typography>
										<OutlinedInput
											id="comments"
											aria-describedby="comments-helper-text"
											value={comments}
											disabled={files.length > 0}
											onChange={(e) => setComments(e.target.value)}
											inputProps={{
												"aria-label": "Comments",
											}}
										/>
									</FormControl>
								</Box>

								{/* Contract workspace name and documents table - Only visible when documents are fetched */}
								{availableDocuments.length > 0 && (
									<>
										<Divider sx={{ my: 3, borderColor: 'rgba(0, 0, 0, 0.12)' }} />

										{/* Associated documents table */}
										<Box sx={{ mt: 3, width: '100%' }}>
											<Box sx={{
												display: 'flex',
												justifyContent: 'space-between',
												alignItems: 'center',
												mb: 1
											}}>
												<Typography variant="subtitle1">Associated Document Names</Typography>
												<Typography variant="body2" color="textSecondary">
													{availableDocuments.length} document(s) found
												</Typography>
											</Box>

											<Paper
												elevation={2}
												sx={{
													width: '100%',
													maxHeight: '300px',
													overflow: 'auto',
													borderRadius: '4px'
												}}
											>
												<AribaMetadataTable
													rows={availableDocuments.map(doc => ({
														document_name: doc.name,
														parent_folder: doc.parent_folder,
														document_id: doc.id,
														last_modified_date: doc.last_modified_date
													}))}
													columns={[
														{
															field: 'document_name',
															headerName: 'Document Name',
															width: 375,
															renderCell: renderDocumentName
														},
														{
															field: 'parent_folder',
															headerName: 'Folder',
															width: 150,
															renderCell: renderDocumentName
														}
													]}
													onSelectionChange={handleSelectionChange}
												/>
											</Paper>
										</Box>
									</>
								)}

								{/* Show a message when fetch is attempted but no documents are found */}
								{fetchAttempted && availableDocuments.length === 0 && (
									<Box sx={{ mt: 3, display: 'flex', alignItems: 'center' }}>
										<InfoOutlinedIcon sx={{ color: 'warning.main', mr: 1 }} />
										<Typography color="text.secondary">
											No documents found for the provided Contract ID. Please verify and try
											again.
										</Typography>
									</Box>
								)}
							</>
						)}
					</Box>
				}
				actions={
					<>
						{uploadType === "Manual" ? (
							<>
								{files.length > 0 ? (
									<Button variant="contained" onClick={handleClose}>
										Done
									</Button>
								) : (
									<>
										<Button onClick={handleClose} color="secondary">
											Cancel
										</Button>
										<Button variant="contained" onClick={handleUploads}>
											Select Files
										</Button>
									</>
								)}
							</>
						) : (
							<>
								<Button onClick={handleClose} color="secondary">
									Cancel
								</Button>
								<Button
									variant="contained"
									onClick={submitSelectedDocuments}
									disabled={selectedDocuments.length === 0}
								>
									Submit Selected Documents
								</Button>
							</>
						)}
					</>
				}
			/>

			{/* for add files only */}
			<ReusableModal
				open={openFilesModal}
				onClose={handleClose}
				title="Add Files"
				content={
					<Box>
						{files.length > 0 && (
							<div style={{ marginTop: "20px" }}>
								<Typography variant="h6">
									Total Files ({files.length})
								</Typography>
								{files && (
									<Paper>
										<DataTable
											data={files.map((file) => ({
												file_name: file.name,
												status:
													uploadStatus[file.name] ||
													"Pending",
											}))}
											columns={columnsFileslist}
											page={page}
											totalCount={files.length}
											setPage={setPage}
											rowsPerPage={rowsPerPage}
											setRowsPerPage={setRowsPerPage}
											showPagination={false}
										/>
									</Paper>
								)}
							</div>
						)}
					</Box>
				}
				actions={
					<>
						{files.length > 0 ? (
							<Button variant="contained" onClick={handleClose}>
								Done
							</Button>
						) : (
							<>
								<Button onClick={handleClose} color="secondary">
									Cancel
								</Button>
								<Button variant="contained" onClick={handleAddFile}>
									Select Files
								</Button>
							</>
						)}
					</>
				}
			/>

			<ReusableModal
				open={openEditModal}
				onClose={handleClose}
				title="Edit Contract Details"
				content={
					<Box>
						{/* Row of dropdowns */}
						<Grid container spacing={2} sx={{ mb: 2 }}>
							{/* Upload Type */}
							<Grid>
								<Box sx={{ display: 'flex', flexDirection: 'column' }}>
									<Typography sx={{ mb: 1 }}>Upload Type</Typography>
									<Select
										value={uploadType}
										onChange={(e) => setUploadType(e.target.value)}
										displayEmpty
										disabled={true} // Should be disabled in edit mode
										sx={{ width: '250px' }}
									>
										<MenuItem value="" disabled>
											Select Upload Type
										</MenuItem>
										<MenuItem value="Ariba">Ariba</MenuItem>
										<MenuItem value="Manual">Manual</MenuItem>
									</Select>
								</Box>
							</Grid>

							{/* Contract Type - Optional */}
							<Grid>
								<Box sx={{ display: 'flex', flexDirection: 'column' }}>
									<Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
										<Typography sx={{ mr: 1 }}>Contract Type</Typography>
									</Box>
									<Select
										value={contractType}
										onChange={(e) => setContractType(e.target.value)}
										displayEmpty
										sx={{ width: '250px' }}
										renderValue={(selected) => {
											if (!selected) {
												return <Typography
													component="em"
													sx={{
														color: 'text.secondary',
														fontStyle: 'italic',
														opacity: 0.7,
														fontSize: '0.875rem'
													}}
												>
													Select Contract Type (Optional)
												</Typography>;
											}
											return selected;
										}}
									>
										<MenuItem value="">
											<em>None</em>
										</MenuItem>
										<MenuItem value="MSA">MSA</MenuItem>
										<MenuItem value="Container Agreement">Container Agreement</MenuItem>
										<MenuItem value="Project Agreement">Project Agreement</MenuItem>
										<MenuItem value="Sub-Agreement">Sub-Agreement</MenuItem>
									</Select>
								</Box>
							</Grid>
						</Grid>

						{uploadType === "Manual" && (
							<Box sx={{ mt: 2 }}>
								<FormControl
									sx={{ width: "850px" }}
									variant="outlined"
									error={!!error}
								>
									<Typography>
										Workspace Name
									</Typography>
									<Box sx={{ mt: '2px' }}>
										<OutlinedInput
											id="workspace-name"
											aria-describedby="workspace-helper-text"
											value={workspaceName}
											style={{ width: '100%' }}
											disabled={openEditModal}
											onChange={(e) =>
												setWorkspaceName(e.target.value)
											}
											inputProps={{
												"aria-label": "Workspace Name",
											}}
											required
										/>
										{error && (
											<Box sx={{ position: 'absolute' }}>
												<FormHelperText id="workspace-helper-text">
													{error}
												</FormHelperText>
											</Box>
										)}
									</Box>
								</FormControl>
							</Box>
						)}

						{uploadType === "Ariba" && (
							<Box sx={{ mt: 2 }}>
								<FormControl
									sx={{ width: "850px" }}
									variant="outlined"
									error={!!error}
								>
									<Typography>
										Ariba Contract Workspace Id
									</Typography>
									<Box sx={{ mt: '2px' }}>
										<OutlinedInput
											id="workspace-id"
											aria-describedby="workspace-helper-text"
											value={workspaceName}
											style={{ width: '100%' }}
											disabled={openEditModal}
											onChange={(e) =>
												setWorkspaceName(e.target.value)
											}
											inputProps={{
												"aria-label": "Workspace Id",
											}}
											required
										/>
										{error && (
											<Box sx={{ position: 'absolute' }}>
												<FormHelperText id="workspace-helper-text">
													{error}
												</FormHelperText>
											</Box>
										)}
									</Box>
								</FormControl>
							</Box>
						)}

						{contractWSAribaName && (
							<Box sx={{ mt: 2 }}>
								<FormControl sx={{ width: "850px" }} variant="outlined">
									<Typography>Ariba Contract Workspace Name</Typography>
									<OutlinedInput
										id="ariba-contract-ws-name"
										aria-describedby="ariba-name-helper-text"
										value={contractWSAribaName}
										disabled
										inputProps={{
											"aria-label": "Ariba Contract Workspace Name",
										}}
									/>
								</FormControl>
							</Box>
						)}

						<Box sx={{ mt: 2 }}>
							<FormControl
								sx={{ width: "850px" }}
								variant="outlined"
							>
								<Typography>Comments</Typography>
								<OutlinedInput
									id="comments"
									aria-describedby="comments-helper-text"
									value={comments}
									onChange={(e) => setComments(e.target.value)}
									inputProps={{
										"aria-label": "Comments",
									}}
								/>
							</FormControl>
						</Box>
					</Box>
				}
				actions={
					<>
						<Button onClick={handleClose} color="secondary">
							Cancel
						</Button>
						<Button variant="contained" onClick={handleUpdateWorkspace}>
							Save
						</Button>
					</>
				}
			/>
			{/* notification on error message */}

			<ReusableModal
				open={modalIsOpen}
				onClose={() => setModalIsOpen(false)}
				title="Notification"
				content={<Typography>{modalMessage}</Typography>}
				actions={<Button onClick={() => setModalIsOpen(false)}>OK</Button>}
			/>

			{/* delete confirmation */}
			<ReusableModal
				open={openDeleteModal}
				onClose={handleClose}
				title="Delete"
				content={
					<Box>
						<Box
							display="flex"
							alignItems="center"
							justifyContent="flex-start"
						>
							<Box>
								<Typography>
									Are you sure you want to delete <strong>{workspaceName}</strong> ?
								</Typography>
							</Box>
						</Box>
					</Box>
				}
				actions={
					<>
						<Button onClick={handleClose} color="secondary">
							Cancel
						</Button>
						<Button variant="contained" onClick={handleDelete}>
							Delete
						</Button>
					</>
				}
			/>

			{/* Share/Unshare Confirmation Modal */}
			{openShareModal && (
				sharedContracts.has(selectedContractId ?? '') ? (
					<ReusableModal
						open={openShareModal}
						onClose={closeShareModal}
						title="Unshare Contract"
						content={
							<Box>
								<Typography>
									Are you sure you want to unshare <strong>{selectedContractName}</strong> from{" "}
									<Typography
										component="span"
										color="secondary"
										sx={{ fontWeight: 'bold' }}
									>
										{selectedDepartmentName}
									</Typography>{" "}
									department?
								</Typography>
							</Box>
						}
						actions={
							<>
								<Button onClick={closeShareModal} color="secondary">
									Cancel
								</Button>
								<Button variant="contained" onClick={handleUnshare}>
									Unshare
								</Button>
							</>
						}
					/>
				) : (
					<ReusableModal
						open={openShareModal}
						onClose={closeShareModal}
						title="Share Contract"
						content={
							<Box>
								<Typography>
									Are you sure you want to share <strong>{selectedContractName}</strong> to{" "}
									<Typography
										component="span"
										color="secondary"
										sx={{ fontWeight: 'bold' }}
									>
										{selectedDepartmentName}
									</Typography>{" "}
									department?
								</Typography>
							</Box>
						}
						actions={
							<>
								<Button onClick={closeShareModal} color="secondary">
									Cancel
								</Button>
								<Button variant="contained" onClick={handleShare}>
									Share
								</Button>
							</>
						}
					/>
				)
			)}



			{/* delete file confirmation */}
			<ReusableModal
				open={openDeleteFileModal}
				onClose={handleClose}
				title="Delete"
				content={
					<Box>
						<Box
							display="flex"
							alignItems="center"
							justifyContent="flex-start"
						>
							<Box>
								<Typography>
									Are you sure you want to delete <strong>{selectedFileName}</strong> ?
								</Typography>
							</Box>
						</Box>
					</Box>
				}
				actions={
					<>
						<Button onClick={handleClose} color="secondary">
							Cancel
						</Button>
						<Button variant="contained" onClick={handleDeleteFile}>
							Delete
						</Button>
					</>
				}
			/>
			<input
				id="file-input"
				ref={fileInputref}
				type="file"
				accept=".pdf"
				multiple
				onChange={handleFileChange}
				style={{ display: "none" }}
			/>
		</Grid>
	);
};

export default ContractManagement;
